import { createHash } from "node:crypto";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readZipEntries } from "../../packages/runtime-native/scripts/check-android-16kb-alignment.mjs";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  type CommandRunner,
  type ICandidateCohort,
  type McpRunner,
  androidApkPrebuiltProofs,
  assertCandidateInstalled,
  assertCandidateIntegrity,
  assertNoLocalSpecifiers,
  assertPublishedApkPrebuilts,
  assertSupportedNodeVersion,
  assertSupportedPackageManager,
  checkLockfile,
  childOutputTail,
  cleanRoomEnvironment,
  mcpRequests,
  realRunner,
  registryEnvironment,
  tarballIntegrity,
  verifyRegistryInstall,
} from "../verify-registry-install.js";

const roots: string[] = [];

/**
 * The version `@threenative/core` carries in this checkout. A release cohort is whatever
 * `publishSet` returns — `@threenative/assets` is a patch ahead of it — so the fixture reads the
 * real one rather than inventing a number the release would never use.
 */
const CORE_VERSION = (
  JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../packages/core/package.json"), "utf8"),
  ) as { version: string }
).version;

async function tempRoot(): Promise<string> {
  const root = await makeTempDir("threenative-registry-spec-");
  roots.push(root);
  return root;
}

/** The bytes the fake registry "published" for `android-arm64-v8a-runtime-v8`. */
const PUBLISHED_RUNTIME_SO = Buffer.from("the published arm64-v8a runtime\n", "utf8");
const PUBLISHED_RUNTIME_SHA = createHash("sha256").update(PUBLISHED_RUNTIME_SO).digest("hex");

const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

/**
 * The smallest archive `readZipEntries` accepts: no padding, no CRC, and every entry stored
 * unless `deflate` names it — the shape a real APK has, where an aligned `.so` is stored and a
 * staged asset is deflated.
 */
function writeApk(
  apk: string,
  entries: Readonly<Record<string, string>>,
  deflate: readonly string[] = [],
): void {
  const names = Object.keys(entries);
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const label = Buffer.from(name, "utf8");
    const contents = Buffer.from(entries[name] as string, "utf8");
    const method = deflate.includes(name) ? ZIP_DEFLATED : ZIP_STORED;
    const data = method === ZIP_STORED ? contents : deflateRawSync(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(label.length, 26);
    locals.push(Buffer.concat([local, label, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(label.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([central, label]));
    offset += local.length + label.length + data.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(apk, Buffer.concat([...locals, centralBytes, end]));
}

/** The two exports the Android leg reads out of the installed runtime-native. */
function writeInstalledRuntime(project: string, version = "9.9.9"): void {
  const scripts = path.join(project, "node_modules", "@threenative", "runtime-native", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(project, "node_modules", "@threenative", "runtime-native", "package.json"),
    JSON.stringify({ name: "@threenative/runtime-native", version }),
  );
  fs.writeFileSync(
    path.join(scripts, "install-prebuilt.mjs"),
    "export function releaseManifestUrl(version) {\n" +
      "  return 'https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v' + version + '/prebuilt-lock.json';\n" +
      "}\n",
  );
  fs.writeFileSync(
    path.join(scripts, "package-android.mjs"),
    "export const ANDROID_PREBUILT_V8_ASSETS = {\n" +
      "  'android-arm64-v8a-runtime-v8': 'jniLibs/arm64-v8a/libmystral-runtime.so',\n" +
      "};\n",
  );
}

/** A runner that writes a registry-clean lockfile and succeeds at every step. */
function happyRunner(): CommandRunner {
  return (command, args, cwd) => {
    if ((command === "npm" || command === "pnpm") && args.includes("create")) {
      const project = path.join(cwd, "my-game");
      fs.mkdirSync(path.join(project, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "my-game",
          scripts: { "build:desktop": "threenative build --target desktop" },
        }),
      );
      fs.writeFileSync(path.join(project, "src", "game.ts"), "export default {};\n");
      writeInstalledRuntime(project);
      fs.mkdirSync(path.join(project, "playtests"), { recursive: true });
      fs.writeFileSync(
        path.join(project, "playtests", "production-readiness.playtest.json"),
        JSON.stringify({ assert: { movement: { entity: "player" } }, name: "pr", steps: [] }),
      );
      // The upgrade proof drives the one scenario both templates ship, so the fixture carries it.
      fs.writeFileSync(
        path.join(project, "playtests", "survives.playtest.json"),
        JSON.stringify({
          assert: {
            components: [{ component: "groundClearance", entity: "player", lte: 0.01 }],
            diagnostics: { runtimeReady: true },
          },
          name: "s",
          steps: [],
        }),
      );
      fs.writeFileSync(
        path.join(project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "threenative-assets": { command: "node", args: ["assets.mjs"] },
            "threenative-blender": { command: "node", args: ["blender.mjs"] },
            "threenative-engine": { command: "node", args: ["engine.mjs"] },
            "threenative-sculpt": { command: "node", args: ["sculpt.mjs"] },
          },
        }),
      );
      return "created";
    }
    if ((command === "npm" || command === "pnpm") && args[0] === "install") {
      fs.writeFileSync(
        path.join(cwd, command === "npm" ? "package-lock.json" : "pnpm-lock.yaml"),
        command === "npm"
          ? JSON.stringify({
              packages: {
                "node_modules/@threenative/core": {
                  resolved: "https://registry.npmjs.org/@threenative/core/-/core-0.2.0.tgz",
                },
              },
            })
          : "lockfileVersion: '9.0'\npackages: {}\n",
      );
      return "installed";
    }
    if (
      (command === "npm" || command === "pnpm") &&
      args[0] === "run" &&
      args[1] === "build:desktop"
    ) {
      fs.mkdirSync(path.join(cwd, "dist-native"), { recursive: true });
      const output = path.join(cwd, "dist-native", "my-game");
      fs.writeFileSync(output, "#!/bin/sh\n");
      fs.chmodSync(output, 0o755);
      return "desktop built";
    }
    if ((command === "npm" || command === "pnpm") && args[0] === "run" && args[1] === "build") {
      // The built bundle carries the source, so the game-only edit applied before the build is
      // observable in the artifact the playtest then exercises.
      fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "dist", "index.js"),
        fs.readFileSync(path.join(cwd, "src", "game.ts"), "utf8"),
      );
      return "built";
    }
    if (args.includes("threenative-playtest")) {
      return "playtest passed: 5 assertions";
    }
    if (
      (command === "npm" || command === "pnpm") &&
      ((command === "npm" && args[0] === "run" && args[1] === "test") ||
        (command === "pnpm" && args[0] === "test"))
    ) {
      return "tested";
    }
    if (
      (command === "npx" && args.includes("doctor")) ||
      (command === "pnpm" && args[0] === "exec" && args.includes("doctor"))
    ) {
      if (!args.includes("--text")) throw new Error("doctor did not use --text");
      return [
        "✓ target web: available",
        "✓ target desktop: available (linux-x64)",
        "✓ target android: available",
        "! target ios: unavailable — requires darwin-arm64",
      ].join("\n");
    }
    if (
      (command === "npm" || command === "pnpm") &&
      args[0] === "run" &&
      args[1] === "build:android"
    ) {
      fs.mkdirSync(path.join(cwd, "dist-native"), { recursive: true });
      writeApk(path.join(cwd, "dist-native", "my-game.apk"), {
        "lib/arm64-v8a/libmystral-runtime.so": PUBLISHED_RUNTIME_SO.toString("utf8"),
      });
      return "android built";
    }
    if (command === "curl") {
      return JSON.stringify({
        artifacts: { "android-arm64-v8a-runtime-v8": { sha256: PUBLISHED_RUNTIME_SHA } },
      });
    }
    if (command === "node" && args[0]?.endsWith("verify-starter-desktop.mjs")) {
      const artifacts = path.join(cwd, "artifacts", "native");
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(
        path.join(artifacts, "starter-desktop-report.json"),
        JSON.stringify({ frames: 300, pass: true }),
      );
      return "starter desktop gate passed: 300 frames";
    }
    return "ok";
  };
}

/**
 * One distributed consumer row, as the runtime-native verifier writes it: `session` is the
 * qualifier's own physical/emulator distinction, so a Pixel 8 arm and an emulator arm are the same
 * target with two different devices.
 */
function consumerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationId: "com.threenative.mygame",
    architecture: "arm64-v8a",
    artifactHash: "3f24116fb41a3e890d51fad9eb4834e3715c284cd023cdb96b310f151015f211",
    assertionIds: ["diagnostics", "movement.axisDelta"],
    assertions: 2,
    failures: [],
    os: "android",
    osVersion: "17 (API 37)",
    pass: true,
    scenario: "playtests/production-readiness.playtest.json",
    session: "android-device",
    target: "android",
    ...overrides,
  };
}

/** Writes the consumer rows the native step reads back, one set per clean room. */
function consumerRowRunner(
  rowsFor: (npm: boolean) => {
    readonly rows: readonly Record<string, unknown>[];
    readonly stdout?: unknown;
  },
): CommandRunner {
  const happy = happyRunner();
  return (command, args, cwd) => {
    const output = happy(command, args, cwd);
    if (command !== "node" || !args[0]?.endsWith("verify-starter-desktop.mjs")) return output;
    const { rows, stdout } = rowsFor(fs.existsSync(path.join(cwd, "package-lock.json")));
    const artifacts = path.join(cwd, "artifacts", "native");
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "consumer-targets.json"), JSON.stringify(rows, null, 2));
    if (stdout !== undefined)
      fs.writeFileSync(
        path.join(artifacts, "consumer-android.stdout.json"),
        JSON.stringify(stdout, null, 2),
      );
    return output;
  };
}

function mcpMessage(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ id, jsonrpc: "2.0", result });
}

function happyMcpRunner(): McpRunner {
  return (serverName, _command, _args, cwd, _env, requests) => {
    const parsed = (requests ?? mcpRequests(serverName))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> },
      );
    const operation = parsed.find((request) => request.method === "tools/call");
    const toolName = (operation?.params?.name as string | undefined) ?? "";
    const tools: Record<string, string[]> = {
      "threenative-assets": ["asset_search_sources"],
      "threenative-blender": ["blender_status", "blender_convert"],
      "threenative-engine": ["engine_search_capabilities", "engine_capability_detail"],
      "threenative-sculpt": ["sculpt_grimoire"],
    };
    const result =
      toolName === "asset_search_sources"
        ? { content: [{ text: JSON.stringify({ sources: [{ id: "kenney" }], total: 1 }) }] }
        : toolName === "sculpt_grimoire"
          ? {
              content: [
                {
                  text: JSON.stringify({
                    text: "Use silhouette and readable geometry.",
                    topic: "glossary/3d_vocabulary",
                  }),
                },
              ],
            }
          : toolName === "engine_search_capabilities"
            ? {
                content: [
                  {
                    text: JSON.stringify({
                      guidance: "",
                      results: [
                        {
                          constraints: ["requires a navigation world"],
                          example: "const agent = new NavigationAgent3D(world);",
                          importPath: "@threenative/physics/navigation",
                          summary: "Move an agent around obstacles.",
                          symbol: "NavigationAgent3D",
                        },
                      ],
                    }),
                  },
                ],
              }
            : toolName === "engine_capability_detail"
              ? {
                  content: [
                    {
                      text: JSON.stringify({
                        importPath: "@threenative/physics/navigation",
                        symbol: "NavigationAgent3D",
                      }),
                    },
                  ],
                }
              : toolName === "blender_status"
                ? {
                    content: [
                      {
                        text: JSON.stringify({
                          available: true,
                          detail: "Blender 4.2",
                          installCommand: "install Blender",
                        }),
                      },
                    ],
                  }
                : {
                    content: [{ text: JSON.stringify({ ok: true }) }],
                  };
    const output = [
      mcpMessage(1, { serverInfo: { name: serverName } }),
      mcpMessage(2, { tools: (tools[serverName] ?? []).map((name) => ({ name })) }),
      mcpMessage(3, result),
    ];
    if (toolName === "blender_convert") {
      const argumentsValue = operation?.params?.arguments as Record<string, unknown> | undefined;
      if (typeof argumentsValue?.out === "string") {
        fs.mkdirSync(path.dirname(argumentsValue.out), { recursive: true });
        fs.writeFileSync(argumentsValue.out, "glb");
      }
    }
    return output.join("\n");
  };
}

describe("pnpm tsx scripts/verify-registry-install.ts", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("passes when every step runs and the lockfile names only the registry", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: happyRunner(),
    });
    expect(report.steps.filter((step) => !step.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.steps.map((step) => step.name)).toEqual(
      ["npm", "pnpm"].flatMap((manager) =>
        [
          "scaffold",
          "install",
          "lockfile",
          "edit",
          "build",
          "test",
          "gameplay",
          "doctor",
          "native",
          "android",
          "mcp",
        ].map((step) => `${manager}:${step}`),
      ),
    );
  });

  it("runs each consumer test command through its selected package manager", async () => {
    const testCommands: string[][] = [];
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (args[0] === "test" || (args[0] === "run" && args[1] === "test"))
          testCommands.push([command, ...args]);
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(0);
    expect(testCommands).toEqual([
      ["npm", "run", "test"],
      ["pnpm", "test"],
    ]);
  });

  it("maps the installed packager's staged arm64 rows to the entries the APK must carry", () => {
    // The real 0.3.3 table, verbatim: the `.aar` names no ABI so it is a build input, `jniLibs`
    // becomes `lib/`, and the V8 snapshot keeps its staged path.
    expect(
      androidApkPrebuiltProofs({
        "android-arm64-v8a-runtime-v8": "jniLibs/arm64-v8a/libmystral-runtime.so",
        "android-arm64-v8a-v8-snapshot": "assets/v8/arm64-v8a/snapshot_blob.bin",
        "android-sdl3-aar": "SDL3-3.2.30.aar",
        "android-x86_64-runtime-v8": "jniLibs/x86_64/libmystral-runtime.so",
      }),
    ).toEqual([
      {
        entry: "lib/arm64-v8a/libmystral-runtime.so",
        key: "android-arm64-v8a-runtime-v8",
      },
      {
        entry: "assets/v8/arm64-v8a/snapshot_blob.bin",
        key: "android-arm64-v8a-v8-snapshot",
      },
    ]);
  });

  it("refuses a prebuilt table that stages no arm64 library at all", () => {
    expect(() => androidApkPrebuiltProofs({ "android-sdl3-aar": "SDL3-3.2.30.aar" })).toThrow(
      /TN_REGISTRY_INSTALL_ANDROID_NO_PREBUILT_ROWS/u,
    );
  });

  it("accepts an APK whose arm64 library is the published byte sequence", async () => {
    const apk = path.join(await tempRoot(), "app.apk");
    writeApk(apk, { "lib/arm64-v8a/libmystral-runtime.so": PUBLISHED_RUNTIME_SO.toString() });
    const proofs = androidApkPrebuiltProofs({
      "android-arm64-v8a-runtime-v8": "jniLibs/arm64-v8a/libmystral-runtime.so",
    });
    expect(
      assertPublishedApkPrebuilts(
        apk,
        readZipEntries(apk),
        {
          "android-arm64-v8a-runtime-v8": { sha256: PUBLISHED_RUNTIME_SHA },
        },
        proofs,
      ),
    ).toMatch(/1 arm64-v8a prebuilt\(s\) verified byte-for-byte/u);
  });

  it("inflates a deflated arm64 asset before comparing it to the published SHA-256", async () => {
    // A staged V8 snapshot is deflated rather than stored, so hashing the entry's compressed
    // bytes would refuse bytes that really are the published ones, and inflating it is what proves
    // them. The compression method is asserted so a fixture that stopped deflating cannot pass
    // through the stored path unnoticed.
    const key = "android-arm64-v8a-v8-snapshot";
    const entry = "assets/v8/arm64-v8a/snapshot_blob.bin";
    const published = Buffer.from("the published arm64-v8a v8 snapshot\n", "utf8");
    const artifacts = { [key]: { sha256: createHash("sha256").update(published).digest("hex") } };
    const proofs = androidApkPrebuiltProofs({ [key]: entry });
    const apk = path.join(await tempRoot(), "app.apk");
    writeApk(apk, { [entry]: published.toString() }, [entry]);
    expect(readZipEntries(apk).entries[0]).toMatchObject({ compression: 8 });
    expect(assertPublishedApkPrebuilts(apk, readZipEntries(apk), artifacts, proofs)).toMatch(
      /1 arm64-v8a prebuilt\(s\) verified byte-for-byte/u,
    );
    writeApk(apk, { [entry]: "compiled on this machine\n" }, [entry]);
    expect(() => assertPublishedApkPrebuilts(apk, readZipEntries(apk), artifacts, proofs)).toThrow(
      /TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH/u,
    );
  });

  it("refuses an APK whose arm64 library is not the published bytes", async () => {
    // A locally compiled `.so` and a stub key are the two ways this box is claimed without proof,
    // and a build exiting 0 distinguishes neither from the published cohort.
    const apk = path.join(await tempRoot(), "app.apk");
    writeApk(apk, {
      "lib/arm64-v8a/libmystral-runtime.so": "compiled on this machine\n",
    });
    const artifacts = { "android-arm64-v8a-runtime-v8": { sha256: PUBLISHED_RUNTIME_SHA } };
    const proofs = androidApkPrebuiltProofs({
      "android-arm64-v8a-runtime-v8": "jniLibs/arm64-v8a/libmystral-runtime.so",
    });
    expect(() => assertPublishedApkPrebuilts(apk, readZipEntries(apk), artifacts, proofs)).toThrow(
      /TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH/u,
    );
    expect(() => assertPublishedApkPrebuilts(apk, readZipEntries(apk), {}, proofs)).toThrow(
      /TN_REGISTRY_INSTALL_ANDROID_NOT_PUBLISHED/u,
    );
    writeApk(apk, { "lib/x86_64/libmystral-runtime.so": PUBLISHED_RUNTIME_SO.toString() });
    expect(() => assertPublishedApkPrebuilts(apk, readZipEntries(apk), artifacts, proofs)).toThrow(
      /TN_REGISTRY_INSTALL_ANDROID_ENTRY_MISSING/u,
    );
  });

  it("reports the android step failed when the APK is not published, never a pass", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (command === "curl")
          return JSON.stringify({
            artifacts: { "android-arm64-v8a-runtime-v8": { sha256: "0".repeat(64) } },
          });
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:android")).toMatchObject({ ok: false });
    expect(report.steps.find((step) => step.name === "npm:android")?.detail).toMatch(
      /TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH/u,
    );
  });

  it("fails, and runs nothing further, when the scaffold 404s", async () => {
    // This is the state of the world today, and the reason the gate exists.
    const report = await verifyRegistryInstall({
      parent: await tempRoot(),
      run: (command, args) => {
        if ((command === "npm" || command === "pnpm") && args.includes("create"))
          throw new Error(
            "npm error 404 Not Found - GET https://registry.npmjs.org/create-threenative",
          );
        return "ok";
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps[0]?.detail).toMatch(/404/u);
    expect(report.steps.slice(1).every((step) => !step.ok)).toBe(true);
    expect(
      report.steps
        .filter((step) => !step.name.endsWith(":scaffold"))
        .every((step) => step.detail.includes("Not run")),
    ).toBe(true);
    expect(report.steps.map((step) => step.name)).toContain("npm:mcp");
    expect(report.steps.map((step) => step.name)).toContain("pnpm:mcp");
  });

  it("fails when the native build produces no executable", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        const output = happyRunner()(command, args, cwd);
        if (command === "npm" && args[0] === "run" && args[1] === "build:desktop") {
          fs.rmSync(path.join(cwd, "dist-native"), { force: true, recursive: true });
          return "desktop build returned without an artifact";
        }
        return output;
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:native")).toMatchObject({ ok: false });
    expect(report.steps.find((step) => step.name === "npm:native")?.detail).toMatch(/executable/u);
  });

  it("fails when the native verifier produces no 300-frame proof", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (command === "node" && args[0]?.endsWith("verify-starter-desktop.mjs"))
          return "native verifier exited without a frame report";
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:native")).toMatchObject({ ok: false });
    expect(report.steps.find((step) => step.name === "npm:native")?.detail).toMatch(/300 frames/u);
  });

  it("fails when doctor text omits the target census", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (command === "npx" && args.includes("doctor"))
          return "doctor passed without naming targets";
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:doctor")).toMatchObject({ ok: false });
    expect(report.steps.find((step) => step.name === "npm:doctor")?.detail).toMatch(/target.*web/u);
  });

  it("fails when an MCP server never answers initialize", async () => {
    const report = await verifyRegistryInstall({
      mcp: (serverName) => {
        if (serverName === "threenative-engine") throw new Error("initialize timed out");
        return happyMcpRunner()(serverName, "node", [], "");
      },
      parent: await tempRoot(),
      run: happyRunner(),
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:mcp")?.detail).toMatch(
      /threenative-engine.*initialize/u,
    );
  });

  it("fails when engine MCP returns a malformed capability hit", async () => {
    const report = await verifyRegistryInstall({
      mcp: (serverName) =>
        serverName === "threenative-engine"
          ? [
              JSON.stringify({
                id: 1,
                jsonrpc: "2.0",
                result: { serverInfo: { name: serverName } },
              }),
              JSON.stringify({
                id: 2,
                jsonrpc: "2.0",
                result: { tools: [{ name: "engine_search_capabilities" }] },
              }),
              JSON.stringify({
                id: 3,
                jsonrpc: "2.0",
                result: { content: [{ text: JSON.stringify([{}]) }] },
              }),
            ].join("\n")
          : happyMcpRunner()(serverName, "node", [], ""),
      parent: await tempRoot(),
      run: happyRunner(),
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:mcp")).toMatchObject({ ok: false });
    expect(report.steps.find((step) => step.name === "npm:mcp")?.detail).toMatch(
      /threenative-engine.*malformed capability hit/u,
    );
  });

  it("does not report a pass for a step that did not run", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args) => {
        if ((command === "npm" || command === "pnpm") && args.includes("create"))
          throw new Error("scaffold failed");
        return "ok";
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.map((step) => step.name)).toEqual(
      ["npm", "pnpm"].flatMap((manager) =>
        [
          "scaffold",
          "install",
          "lockfile",
          "edit",
          "build",
          "test",
          "gameplay",
          "doctor",
          "native",
          "android",
          "mcp",
        ].map((step) => `${manager}:${step}`),
      ),
    );
    expect(report.steps.slice(1).every((step) => step.ok === false)).toBe(true);
  });

  it("fails when the lockfile resolves a dependency from this machine", async () => {
    const report = await verifyRegistryInstall({
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (command === "npm" && args[0] === "install") {
          fs.writeFileSync(
            path.join(cwd, "package-lock.json"),
            JSON.stringify({
              packages: {
                "node_modules/@threenative/core": { resolved: "file:../../packages/core" },
              },
            }),
          );
          return "installed";
        }
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:lockfile")?.detail).toMatch(
      /TN_REGISTRY_INSTALL_LOCAL_SPECIFIER/u,
    );
  });

  it("rejects a link: specifier as well as file:", () => {
    expect(() =>
      assertNoLocalSpecifiers("pnpm-lock.yaml", "  '@threenative/ui': link:../../packages/ui\n"),
    ).toThrow(/TN_REGISTRY_INSTALL_LOCAL_SPECIFIER/u);
  });

  it("refuses a project with no lockfile rather than finding no offenders", async () => {
    // Vacuous green: no lockfile means no matches means "clean", unless the absence is a failure.
    const root = await tempRoot();
    expect(() => checkLockfile(root)).toThrow(/TN_REGISTRY_INSTALL_NO_LOCKFILE/u);
  });

  it("accepts a lockfile that names only registry tarballs", async () => {
    const root = await tempRoot();
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ resolved: "https://registry.npmjs.org/@threenative/core/-/core-0.2.0.tgz" }),
    );
    expect(checkLockfile(root)).toBe("package-lock.json");
  });

  it("refuses an unsupported Node prerequisite before starting a clean room", () => {
    expect(() => assertSupportedNodeVersion("20.18.1")).toThrow(/20\.19\.0/u);
    expect(() => assertSupportedNodeVersion("19.9.0")).toThrow(/20\.19\.0/u);
    expect(() => assertSupportedNodeVersion("20.19.0")).not.toThrow();
  });

  it("refuses an unrecognized package manager instead of guessing its install policy", () => {
    expect(() => assertSupportedPackageManager("yarn")).toThrow(/use npm or pnpm/u);
  });

  it("keeps install-script policy explicit and does not add a bypass flag", async () => {
    const installs: string[][] = [];
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      packageManagers: ["npm"],
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (args[0] === "install") installs.push([command, ...args]);
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(0);
    expect(installs).toHaveLength(1);
    expect(installs[0]).not.toContain("--ignore-scripts");
    expect(installs[0]).not.toContain("--unsafe-perm");
  });

  it("uses pnpm create's native option forwarding syntax", async () => {
    const scaffolds: string[][] = [];
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      packageManagers: ["pnpm"],
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (command === "pnpm" && args[0] === "create") scaffolds.push([...args]);
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(0);
    expect(scaffolds[0]).toEqual([
      "create",
      "threenative@latest",
      "my-game",
      "--template",
      "starter",
      "--no-install",
    ]);
  });

  it("refuses an empty manager matrix instead of reporting a vacuous pass", async () => {
    await expect(verifyRegistryInstall({ packageManagers: [] })).rejects.toThrow(
      /TN_REGISTRY_INSTALL_NO_PACKAGE_MANAGERS/u,
    );
  });

  it("rejects a consumer whose gameplay scenario declares no assertions", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        const output = happyRunner()(command, args, cwd);
        if ((command === "npm" || command === "pnpm") && args.includes("create")) {
          fs.writeFileSync(
            path.join(cwd, "my-game", "playtests", "production-readiness.playtest.json"),
            JSON.stringify({ assert: {}, name: "pr", steps: [] }),
          );
        }
        return output;
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:gameplay")?.detail).toMatch(
      /TN_REGISTRY_INSTALL_GAMEPLAY_NO_ASSERTIONS/u,
    );
  });

  it("rejects a consumer whose production-readiness scenario was removed", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        const output = happyRunner()(command, args, cwd);
        if ((command === "npm" || command === "pnpm") && args.includes("create")) {
          fs.rmSync(path.join(cwd, "my-game", "playtests", "production-readiness.playtest.json"), {
            force: true,
          });
        }
        return output;
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:gameplay")?.detail).toMatch(
      /TN_REGISTRY_INSTALL_GAMEPLAY_SCENARIO_MISSING/u,
    );
  });

  it("rejects a consumer whose real gameplay assertions are false", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (args.includes("threenative-playtest")) {
          throw new Error("TN_ASSERTION_FAILED: player displacement was 0");
        }
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:gameplay")?.detail).toMatch(
      /TN_ASSERTION_FAILED/u,
    );
  });

  it("rejects when the game-only edit did not reach the build", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if ((command === "npm" || command === "pnpm") && args[0] === "run" && args[1] === "build") {
          return "built without the edit";
        }
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "npm:gameplay")?.detail).toMatch(
      /TN_REGISTRY_INSTALL_GAMEPLAY_EDIT_NOT_BUILT/u,
    );
  });

  it("drives the gameplay scenario with a display, a server and an explicit adapter policy", async () => {
    const playtests: string[][] = [];
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (args.includes("threenative-playtest")) playtests.push([command, ...args]);
        return happyRunner()(command, args, cwd);
      },
    });
    expect(report.exitCode).toBe(0);
    expect(playtests).toHaveLength(2);
    for (const args of playtests) {
      expect(args).toContain("playtests/production-readiness.playtest.json");
      expect(args).toContain("--server-command");
      expect(args).toContain("--browser-recipe");
      expect(args[args.indexOf("--browser-recipe") + 1]).toBe("webgpu");
      expect(args).toContain("--headed");
      expect(args).toContain("--allow-software");
    }
    // npm uses `npx --no-install`, not `npm exec --no-install`, which warns on npm 11.
    expect(playtests.map(([command]) => command).sort()).toEqual(["npx", "pnpm"]);
  });

  it("carries a physical and an emulator arm of one target as separate cohort rows", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: consumerRowRunner((npm) => ({
        rows: [
          npm
            ? consumerRow()
            : consumerRow({
                architecture: "x86_64",
                artifactHash: "9c1d0a4b7e2f5630bd4a8c9112ee73045ab6cd7f19e2b4d0c8a5f61729be340",
                osVersion: "15 (API 35)",
                session: "android-emulator",
              }),
        ],
      })),
    });
    expect(report.exitCode).toBe(0);
    // The target alone cannot hold both: PRD-366 phase 2 lost the Pixel 8 row to the emulator run.
    expect(report.consumerTargets).toHaveLength(2);
    expect(
      report.consumerTargets
        .map((row) => ({
          architecture: row.architecture,
          artifactHash: row.artifactHash,
          osVersion: row.osVersion,
          session: row.session,
        }))
        .sort((left, right) => left.session.localeCompare(right.session)),
    ).toEqual([
      {
        architecture: "arm64-v8a",
        artifactHash: "3f24116fb41a3e890d51fad9eb4834e3715c284cd023cdb96b310f151015f211",
        osVersion: "17 (API 37)",
        session: "android-device",
      },
      {
        architecture: "x86_64",
        artifactHash: "9c1d0a4b7e2f5630bd4a8c9112ee73045ab6cd7f19e2b4d0c8a5f61729be340",
        osVersion: "15 (API 35)",
        session: "android-emulator",
      },
    ]);
  });

  it("retains the run's own first diagnostic when an arm aborted before any assertion", async () => {
    // `failureReport()` emits this shape for ANY abort before assertions run, so a row carrying
    // only the verifier's message cannot say what failed — which is why phase 2's one physical
    // arm64 abort is still unexplained.
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: consumerRowRunner(() => ({
        rows: [
          consumerRow({
            assertionIds: [],
            assertions: 0,
            failures: ["assertion 'diagnostics' was not evaluated"],
            pass: false,
          }),
        ],
        stdout: {
          diagnostics: [
            {
              code: "TN_PLAYTEST_ANDROID_LAUNCH",
              message: "the installed app never reached the foreground",
              severity: "error",
            },
          ],
          pass: false,
        },
      })),
    });
    // The real failure path: a row the verifier marked failed must fail the cohort, and the report
    // must still carry what the run reported rather than only the abort.
    expect(report.exitCode).toBe(1);
    const native = report.steps.filter((step) => step.name.endsWith(":native"));
    expect(native).toHaveLength(2);
    for (const item of native) expect(item.detail).toContain("TN_PLAYTEST_ANDROID_LAUNCH");
    expect(
      report.consumerTargets.find((row) => row.session === "android-device")?.failures,
    ).toEqual([
      "assertion 'diagnostics' was not evaluated",
      "TN_PLAYTEST_ANDROID_LAUNCH: the installed app never reached the foreground",
    ]);
  });

  it("names the missing diagnostic instead of inventing a cause for a zero-assertion arm", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: consumerRowRunner(() => ({
        rows: [consumerRow({ assertionIds: [], assertions: 0, pass: false })],
      })),
    });
    expect(
      report.consumerTargets.find((row) => row.session === "android-device")?.failures,
    ).toEqual([expect.stringContaining("TN_REGISTRY_INSTALL_CONSUMER_DIAGNOSTIC_MISSING")]);
  });

  it("fails the cohort on a zero-assertion arm even when the row claims it passed", async () => {
    const report = await verifyRegistryInstall({
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: consumerRowRunner(() => ({
        rows: [consumerRow({ assertionIds: [], assertions: 0, pass: true })],
        stdout: {
          diagnostics: [
            {
              code: "TN_PLAYTEST_ANDROID_LAUNCH",
              message: "the installed app never reached the foreground",
              severity: "error",
            },
          ],
          pass: true,
        },
      })),
    });
    // An empty assertion set is a failure whatever `pass` says (AGENTS.md's empty-assertion rule):
    // a row that asserted nothing has proved nothing, so it cannot carry a cohort.
    expect(report.exitCode).toBe(1);
    const native = report.steps.filter((step) => step.name.endsWith(":native"));
    expect(native).toHaveLength(2);
    for (const item of native)
      expect(item.detail).toContain("TN_REGISTRY_INSTALL_CONSUMER_TARGET_FAILED");
    // The row and its diagnostic survive the abort, so the recorded cause is not lost to it.
    expect(
      report.consumerTargets.find((row) => row.session === "android-device")?.failures,
    ).toEqual(["TN_PLAYTEST_ANDROID_LAUNCH: the installed app never reached the foreground"]);
  });
});

// PRD-446 phase 3. The claim is that a game written against the previous `latest` upgrades onto the
// candidate and still plays — so every assertion below is about which bytes ended up in the
// project, not about whether an install command exited 0.
describe("the PRD-446 upgrade proof", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  /** The `integrity` a manager records for a tarball, stated here so the proof is not graded on itself. */
  function packedIntegrity(tarball: string): string {
    return `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
  }

  /**
   * A real tarball on disk at the version `@threenative/core` carries in this checkout, because the
   * identity proof hashes bytes rather than reading a name.
   */
  async function packedCandidate(): Promise<ICandidateCohort> {
    const root = await tempRoot();
    const file = path.join(root, `threenative-core-${CORE_VERSION}.tgz`);
    fs.writeFileSync(file, `the packed @threenative/core ${CORE_VERSION} candidate bytes\n`);
    return {
      tarballs: { "@threenative/core": file },
      versions: new Map([["@threenative/core", CORE_VERSION]]),
    };
  }

  /** Resolve the candidate the way a `file:` tarball install would: the version we packed. */
  function installCandidate(cwd: string, version: string): void {
    const directory = path.join(cwd, "node_modules", "@threenative", "core");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "@threenative/core", version }),
    );
  }

  /** The lockfile entry pnpm writes for a `file:` tarball, with an explicit integrity to grade. */
  function writePnpmLockfile(
    cwd: string,
    tarballs: readonly string[],
    integrity: (t: string) => string,
  ): void {
    const entries = tarballs.map((tarball) => {
      const base = path.basename(tarball);
      return [
        `  '@threenative/core@file:../../${base}':`,
        `    resolution: {integrity: ${integrity(tarball)}, tarball: file:../../${base}}`,
        `    version: ${CORE_VERSION}`,
      ].join("\n");
    });
    fs.writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\n\npackages:\n\n${entries.join("\n")}\n\nsnapshots:\n\n${entries.map((entry) => entry.split("\n")[0]).join("\n")} {}\n`,
    );
  }

  function upgradeRunner(
    seen: { installs: string[][]; playtests: string[][] },
    candidate: ICandidateCohort,
    options: { integrity?: (tarball: string) => string; version?: string } = {},
  ): CommandRunner {
    return (command, args, cwd) => {
      if (args.includes("threenative-playtest")) seen.playtests.push([command, ...args]);
      if (
        (command === "npm" || command === "pnpm") &&
        args[0] === "install" &&
        args.some((argument) => argument.endsWith(".tgz"))
      ) {
        seen.installs.push([command, ...args]);
        // A cohort package reached only through another one resolves from these overrides, not
        // from the command line, so a missing one is a registry fetch of an unpublished version.
        const { pnpm } = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
          pnpm?: { overrides?: Record<string, string> };
        };
        for (const [name, tarball] of Object.entries(candidate.tarballs))
          if (pnpm?.overrides?.[name] !== `file:${tarball}`)
            throw new Error(`${name} is not overridden to its packed tarball`);
        installCandidate(cwd, options.version ?? CORE_VERSION);
        writePnpmLockfile(
          cwd,
          Object.values(candidate.tarballs),
          options.integrity ?? ((tarball) => packedIntegrity(tarball)),
        );
        return "installed the candidate cohort";
      }
      return happyRunner()(command, args, cwd);
    };
  }

  it("upgrades the previous latest onto the packed candidate and plays that template's scenario", async () => {
    const candidate = await packedCandidate();
    const tarball = candidate.tarballs["@threenative/core"] as string;
    const seen = { installs: [] as string[][], playtests: [] as string[][] };
    const report = await verifyRegistryInstall({
      candidate,
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: upgradeRunner(seen, candidate),
      surfaceCheck: () => {},
    });
    expect(report.exitCode).toBe(0);
    expect(report.steps.filter((step) => !step.ok)).toEqual([]);
    // One manager, not two: the candidate is a set of tarballs whose identity one lockfile settles.
    expect(report.managers).toEqual(["pnpm"]);
    expect(report.steps.map((step) => step.name)).toEqual([
      "pnpm:scaffold",
      "pnpm:install",
      "pnpm:lockfile",
      "pnpm:surface",
      "pnpm:upgrade",
      "pnpm:edit",
      "pnpm:build",
      "pnpm:test",
      "pnpm:gameplay",
    ]);
    // The upgrade is an install of the packed tarballs, onto the registry-clean project.
    expect(seen.installs).toHaveLength(1);
    expect(seen.installs[0]).toContain(tarball);
    // The scenario is the template's own, not the registry lane's production-readiness guard.
    for (const playtest of seen.playtests) {
      expect(playtest).toContain("playtests/survives.playtest.json");
      expect(playtest).not.toContain("playtests/production-readiness.playtest.json");
    }
    const upgrade = report.steps.find((step) => step.name === "pnpm:upgrade")?.detail ?? "";
    expect(upgrade).toContain(`@threenative/core@${CORE_VERSION}`);
    expect(upgrade).toContain(packedIntegrity(tarball));
  });

  it("claims web only, so it runs neither the native nor the MCP step", async () => {
    const candidate = await packedCandidate();
    const report = await verifyRegistryInstall({
      candidate,
      mcp: happyMcpRunner(),
      parent: await tempRoot(),
      run: upgradeRunner({ installs: [], playtests: [] }, candidate),
      surfaceCheck: () => {},
    });
    const names = report.steps.map((step) => step.name);
    expect(names).not.toContain("pnpm:native");
    expect(names).not.toContain("pnpm:mcp");
    expect(names).not.toContain("pnpm:doctor");
  });

  it("refuses a candidate whose public break is unannounced, before installing a byte of it", async () => {
    const candidate = await packedCandidate();
    const seen = { installs: [] as string[][], playtests: [] as string[][] };
    const report = await verifyRegistryInstall({
      candidate,
      parent: await tempRoot(),
      run: upgradeRunner(seen, candidate),
      surfaceCheck: () => {
        throw new Error(
          "api surface: removed symbol @threenative/core#gone has no Breaking entry naming it",
        );
      },
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "pnpm:surface")?.detail).toMatch(
      /has no Breaking entry/u,
    );
    expect(seen.installs).toEqual([]);
    expect(report.steps.find((step) => step.name === "pnpm:upgrade")?.detail).toMatch(/Not run/u);
    expect(report.steps.find((step) => step.name === "pnpm:gameplay")?.detail).toMatch(/Not run/u);
  });

  it("stops the case when the candidate install fails, so no unproven tree is built or played", async () => {
    const candidate = await packedCandidate();
    const seen = { installs: [] as string[][], playtests: [] as string[][] };
    const report = await verifyRegistryInstall({
      candidate,
      parent: await tempRoot(),
      run: (command, args, cwd) => {
        if (args.includes("threenative-playtest")) seen.playtests.push([command, ...args]);
        if (
          (command === "npm" || command === "pnpm") &&
          args[0] === "install" &&
          args.some((argument) => argument.endsWith(".tgz"))
        )
          throw new Error("ERR_PNPM_TARBALL_INTEGRITY  the candidate tarball does not match");
        return happyRunner()(command, args, cwd);
      },
      surfaceCheck: () => {},
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "pnpm:upgrade")?.detail).toMatch(
      /does not match/u,
    );
    for (const name of ["pnpm:edit", "pnpm:build", "pnpm:test", "pnpm:gameplay"])
      expect(report.steps.find((step) => step.name === name)?.detail).toMatch(/Not run/u);
    expect(seen.playtests).toEqual([]);
  });

  it("rejects an upgrade that left the consumer on the previous latest", async () => {
    const candidate = await packedCandidate();
    const report = await verifyRegistryInstall({
      candidate,
      parent: await tempRoot(),
      run: upgradeRunner({ installs: [], playtests: [] }, candidate, { version: "0.3.2" }),
      surfaceCheck: () => {},
    });
    expect(report.exitCode).toBe(1);
    expect(report.steps.find((step) => step.name === "pnpm:upgrade")?.detail).toMatch(
      new RegExp(
        `TN_REGISTRY_UPGRADE_VERSION_MISMATCH.*@0\\.3\\.2, not the candidate ${CORE_VERSION}`,
        "u",
      ),
    );
  });

  it("rejects a matching version whose bytes are not the candidate's, which is the case a version cannot catch", async () => {
    const candidate = await packedCandidate();
    const report = await verifyRegistryInstall({
      candidate,
      parent: await tempRoot(),
      // Same version installed, an integrity that is not the tarball's: the development cohort
      // sharing `latest`'s version, resolved from the registry instead of the packed bytes.
      run: upgradeRunner({ installs: [], playtests: [] }, candidate, {
        integrity: () => `sha512-${"A".repeat(86)}==`,
      }),
      surfaceCheck: () => {},
    });
    expect(report.exitCode).toBe(1);
    const detail = report.steps.find((step) => step.name === "pnpm:upgrade")?.detail ?? "";
    expect(detail).toMatch(/TN_REGISTRY_UPGRADE_INTEGRITY_MISMATCH/u);
    expect(detail).toContain(`sha512-${"A".repeat(86)}==`);
    expect(report.steps.find((step) => step.name === "pnpm:gameplay")?.detail).toMatch(/Not run/u);
  });

  it("reads the candidate back out of the installed tree, and fails closed without one", async () => {
    const candidate = await packedCandidate();
    const tarball = candidate.tarballs["@threenative/core"] as string;
    const root = await tempRoot();
    installCandidate(root, CORE_VERSION);
    expect(assertCandidateInstalled(root, candidate.versions)).toBe(
      `@threenative/core@${CORE_VERSION}`,
    );
    expect(() => assertCandidateInstalled(root, new Map())).toThrow(
      /TN_REGISTRY_UPGRADE_NO_CANDIDATE/u,
    );
    expect(() =>
      assertCandidateInstalled(root, new Map([["@threenative/physics", CORE_VERSION]])),
    ).toThrow(/TN_REGISTRY_UPGRADE_NOT_INSTALLED.*@threenative\/physics/u);

    // The byte proof agrees with the manager's own lockfile field, in both formats.
    expect(tarballIntegrity(tarball)).toBe(packedIntegrity(tarball));
    writePnpmLockfile(root, [tarball], packedIntegrity);
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@threenative/core": {
            integrity: packedIntegrity(tarball),
            resolved: `file:../../${path.basename(tarball)}`,
          },
        },
      }),
    );
    expect(assertCandidateIntegrity(root, candidate.tarballs)).toContain(packedIntegrity(tarball));
    expect(() =>
      assertCandidateIntegrity(root, { "@threenative/core": path.join(root, "gone.tgz") }),
    ).toThrow(/TN_REGISTRY_UPGRADE_TARBALL_MISSING/u);
  });

  it("fails closed when no lockfile records the candidate's integrity at all", async () => {
    const root = await tempRoot();
    const tarball = path.join(root, "threenative-core-0.3.3.tgz");
    fs.writeFileSync(tarball, "candidate bytes\n");
    expect(() => assertCandidateIntegrity(root, { "@threenative/core": tarball })).toThrow(
      /TN_REGISTRY_UPGRADE_NO_LOCKFILE/u,
    );
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\npackages:\n\n  '@threenative/core@0.3.3':\n    resolution: {registry: 'https://registry.npmjs.org/'}\n",
    );
    expect(() => assertCandidateIntegrity(root, { "@threenative/core": tarball })).toThrow(
      /TN_REGISTRY_UPGRADE_INTEGRITY_MISMATCH.*no recorded integrity/u,
    );
  });
});

// pnpm exports its own settings as `npm_config_*`. npm reads them as its own config, warns
// "Unknown env config" about each, and died on `Cannot read properties of null (reading 'matches')`
// — reporting the freshly published packages as uninstallable while a plain `npm install` of the
// same project succeeded. A clean room that inherits the caller's package-manager config is not a
// clean room.
describe("clean room environment", () => {
  it("drops the invoking package manager's config and keeps everything else", () => {
    const cleaned = cleanRoomEnvironment({
      HOME: "/home/dev",
      PATH: "/usr/bin",
      npm_config_catalog: "{}",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_verify_deps_before_run: "false",
      NPM_CONFIG_CACHE: "/somewhere/else",
      npm_package_name: "threenative",
      npm_lifecycle_event: "release",
      THREENATIVE_SOMETHING: "kept",
    });

    // The machine is still the machine.
    expect(cleaned.HOME).toBe("/home/dev");
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.THREENATIVE_SOMETHING).toBe("kept");

    // Nothing the caller's package manager said about itself survives.
    for (const name of Object.keys(cleaned)) {
      expect(name.toLowerCase().startsWith("npm_config_")).toBe(false);
      expect(name.toLowerCase().startsWith("npm_package_")).toBe(false);
      expect(name.toLowerCase().startsWith("npm_lifecycle_")).toBe(false);
    }
  });

  it("gives pnpm create and install a private store", () => {
    const environment = registryEnvironment(
      { npm_config_store_dir: "/global/store", npm_config_registry: "https://registry.invalid" },
      "pnpm",
      "/private/cache",
      "/private/store",
    );

    expect(environment.npm_config_store_dir).toBe("/private/store");
    expect(environment.NPM_CONFIG_CACHE).toBe("/private/cache");
    expect(environment.npm_config_registry).toBeUndefined();
  });
});

describe("a failed child command", () => {
  it("keeps the output the child wrote to stdout, bounded", () => {
    // pnpm reports a resolution failure on stdout, and `execFileSync`'s own message says only
    // `Command failed: ...`. The step report used to carry the command line and not the reason.
    const run = realRunner({ PATH: process.env.PATH ?? "" });
    let thrown: unknown;
    try {
      run(
        process.execPath,
        [
          "-e",
          "process.stdout.write('ERR_PNPM_NO_MATCHING_VERSION x'.repeat(400));process.exit(1)",
        ],
        process.cwd(),
      );
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("ERR_PNPM_NO_MATCHING_VERSION");
    // Bounded: an install prints megabytes, and the report keeps the last screenful.
    expect(message.length).toBeLessThan(4_000);
    expect(message).toContain("\n...");
  });

  it("says nothing extra when the child was quiet", () => {
    expect(childOutputTail(new Error("Command failed: pnpm install"))).toBe("");
    expect(childOutputTail("not an error")).toBe("");
  });
});
