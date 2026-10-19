import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock, spawnSync: spawnSyncMock };
});

import { MCP_HOSTS } from "../../core/mcp/install.mjs";
import { assertNativeAssetsCompatible } from "../src/build.js";
import {
  ANDROID_RELEASE_SIGNING_ENV,
  BLENDER_SERVER,
  type IProjectSnapshot,
  MCP_SERVER_SPECS,
  detectX11Compositor,
  diagnoseProject,
  formatDoctorReport,
  nativeRuntimeCheck,
  probeAndroidToolchain,
  probeDesktopOverlay,
  probeNativeHost,
  readProject,
} from "../src/doctor.js";
import { MCP_SERVERS } from "../src/mcp-servers.js";

const MCP_HOST_TABLE = MCP_HOSTS as readonly { readonly file: string; readonly label: string }[];

const CORE_PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../core/package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

// Built from core's own server table rather than retyped: a hand-written healthy fixture is a
// fixture that stops being healthy the day a server is added, and the failure reads as a doctor
// bug rather than as a stale test.
const MCP_CONFIG = JSON.stringify({
  mcpServers: Object.fromEntries(
    Object.entries(MCP_SERVERS).map(([name, server]) => [
      name,
      {
        command: server.command,
        args: [...server.args],
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      },
    ]),
  ),
});

const HEALTHY: IProjectSnapshot = {
  config: { nativeEntry: "src/game.ts" },
  files: new Set([
    ".mcp.json",
    "package.json",
    "playtests/smoke.playtest.json",
    "src/game.ts",
    "src/main.ts",
  ]),
  installedVersions: new Map([
    ["@threenative/core", "0.4.0"],
    ["@threenative/physics", "0.4.0"],
    ["@threenative/runtime-native", "0.4.0"],
  ]),
  packageJson: {
    dependencies: { "@threenative/core": "0.4.0", "@threenative/physics": "0.4.0" },
    name: "my-game",
    optionalDependencies: { "@threenative/runtime-native": "0.4.0" },
  },
  readText: (relative) =>
    relative === "src/game.ts"
      ? "export default defineGame({})"
      : relative === ".mcp.json"
        ? MCP_CONFIG
        : "",
  readRuntimeText: (relative) =>
    relative === "prebuilt/install-status.json"
      ? JSON.stringify({
          key: `${process.platform}-${process.arch}`,
          ok: true,
          reason: "installed",
          url: "https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.4.0/prebuilt-lock.json",
          version: "0.4.0",
        })
      : undefined,
  runtimeFileExists: (relative) =>
    relative ===
      `prebuilt/${process.platform}-${process.arch}/${process.platform === "win32" ? "threenative-runtime.exe" : "threenative-runtime"}` ||
    relative === "scripts/package-android.mjs" ||
    relative === "scripts/package-ios.mjs",
  runtimeManifestUrl:
    "https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.4.0/prebuilt-lock.json",
  // A host at the engine's own version: the prebuilt a project installs must at least match the
  // engine it has to satisfy, and doctor reads this from the binary, not from the package.
  nativeHost: { runtimeVersion: "0.4.0" },
  runtimeRoot: "/runtime-native",
};

const APK_SHA256 = "409a7f83ac6b31dc8c77e3ec18038f209bd2f545e0f4177c2e2381aa4e067b49";

function snapshot(overrides: Partial<IProjectSnapshot>): IProjectSnapshot {
  return { ...HEALTHY, ...overrides };
}

function check(report: ReturnType<typeof diagnoseProject>, name: string) {
  const found = report.checks.find((candidate) => candidate.name === name);
  if (found === undefined)
    throw new Error(`no check named '${name}' in ${report.checks.map((c) => c.name).join(", ")}`);
  return found;
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform descriptor is missing");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({
    stderr: 'openjdk version "17.0.1"',
    stdout: "",
    status: 0,
  });
});

/** The version a `workspace:` dependency resolves to: the in-repo package's own manifest. */
async function workspaceVersion(packageName: string): Promise<string> {
  const root = path.resolve("packages");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "package.json");
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const manifest = JSON.parse(raw) as { name?: string; version?: string };
    if (manifest.name === packageName && manifest.version !== undefined) return manifest.version;
  }
  throw new Error(`No workspace package named '${packageName}'.`);
}

describe("threenative doctor", () => {
  it("names the compositor-less X11 blocker before a build", () => {
    const probe = probeDesktopOverlay({ DISPLAY: ":99" }, () => false);
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/game.ts", ui: { renderer: "web" } },
        desktopOverlay: probe,
      }),
    );

    expect(check(report, "desktop overlay")).toMatchObject({
      detail: expect.stringContaining("no compositing manager is running"),
      status: "fail",
    });
    // Naming them is the difference between a blocker and a fix: these are the three the
    // repository's own private displays start, so a reader can install one and move on.
    expect(formatDoctorReport(report)).toContain(
      "Start a compositing manager (xcompmgr -n, picom or compton",
    );
  });

  it("reports a Wayland/Xwayland session as supported and a Wayland one without Xwayland as blocked", () => {
    const supported = probeDesktopOverlay(
      { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
      () => true,
    );
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/game.ts", ui: { renderer: "web" } },
        desktopOverlay: supported,
      }),
    );

    expect(supported).toMatchObject({
      detail: expect.stringContaining("Xwayland"),
      status: "ok",
    });
    expect(check(report, "desktop overlay")).toMatchObject({ status: "ok" });

    const blocked = probeDesktopOverlay(
      { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
      () => true,
    );
    expect(blocked).toMatchObject({ status: "fail" });
    expect(blocked.detail).toContain("Xwayland");
  });

  it("does not report a desktop overlay blocker for native UI", () => {
    const probe = probeDesktopOverlay({ DISPLAY: ":99" }, () => false);
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/game.ts", ui: { renderer: "native" } },
        desktopOverlay: probe,
      }),
    );

    expect(report.checks.some(({ name }) => name === "desktop overlay")).toBe(false);
    expect(report.pass).toBe(true);
  });

  it("passes a healthy scaffolded project", () => {
    const report = diagnoseProject(HEALTHY);
    expect(report.pass).toBe(true);
    expect(report.checks.every(({ status }) => status !== "fail")).toBe(true);
    expect(check(report, "native runtime")).toMatchObject({ status: "ok" });
    expect(check(report, "native runtime").detail).toMatch(/^available/u);
  });

  it("fails when there is no package.json to read", () => {
    const report = diagnoseProject(snapshot({ files: new Set(), packageJson: undefined }));
    expect(report.pass).toBe(false);
    expect(check(report, "package.json").status).toBe("fail");
  });

  it("fails when a declared @threenative dependency was never installed", () => {
    const report = diagnoseProject(
      snapshot({ installedVersions: new Map([["@threenative/core", "0.4.0"]]) }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "dependencies").detail).toMatch(/@threenative\/physics/);
    expect(check(report, "dependencies").fix).toMatch(/install/i);
  });

  it("accepts a patch difference inside one 0.x series", () => {
    const report = diagnoseProject(
      snapshot({
        installedVersions: new Map([
          ["@threenative/core", "0.3.4"],
          ["@threenative/physics", "0.3.5"],
        ]),
      }),
    );
    expect(check(report, "versions").status).toBe("ok");
  });

  it("fails when installed @threenative packages disagree on version, naming both", () => {
    const report = diagnoseProject(
      snapshot({
        installedVersions: new Map([
          ["@threenative/core", "0.4.0"],
          ["@threenative/physics", "0.3.1"],
        ]),
      }),
    );
    expect(report.pass).toBe(false);
    const detail = check(report, "versions").detail;
    expect(detail).toMatch(/0\.4\.0/);
    expect(detail).toMatch(/0\.3\.1/);
  });

  it("fails when the portable entry is missing, because native builds start there", () => {
    const report = diagnoseProject(
      snapshot({
        files: new Set([
          ".mcp.json",
          "package.json",
          "playtests/smoke.playtest.json",
          "src/main.ts",
        ]),
      }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "native entry").detail).toMatch(/src\/game\.ts/);
  });

  it("fails a portable entry that exports no default game, the way the native host does", () => {
    const report = diagnoseProject(
      snapshot({ readText: () => "export const game = defineGame({})" }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "native entry").detail).toMatch(/default/);
  });

  it("honours a configured native entry instead of assuming src/game.ts", () => {
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/entry/native.ts" },
        files: new Set([
          ".mcp.json",
          "package.json",
          "playtests/smoke.playtest.json",
          "src/entry/native.ts",
          "src/main.ts",
        ]),
        readText: (relative) => (relative === "src/entry/native.ts" ? "export default {}" : ""),
      }),
    );
    expect(check(report, "native entry").status).toBe("ok");
  });

  it("fails when the authoring agent has no capability search", () => {
    const report = diagnoseProject(
      snapshot({ files: new Set(["package.json", "src/game.ts", "src/main.ts"]) }),
    );
    expect(check(report, "playtests").status).toBe("warn");
    expect(check(report, "capability search").status).toBe("fail");
    expect(check(report, "capability search").detail).toMatch(/capabilit/i);
    expect(report.pass).toBe(false);
  });

  it("warns when the core package that owns engine discovery is absent", () => {
    const report = diagnoseProject(
      snapshot({
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
      }),
    );
    const engine = report.checks.find(({ name }) => name.includes("@threenative/core"));
    expect(engine).toMatchObject({ status: "warn" });
    expect(engine?.detail).toContain(`@threenative/core@${CORE_PACKAGE_VERSION}`);
  });

  it("reports each MCP server separately", () => {
    const report = diagnoseProject(
      snapshot({
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
      }),
    );
    const serverChecks = report.checks.filter(({ name }) => name.startsWith("capability search:"));
    expect(serverChecks).toHaveLength(MCP_SERVER_SPECS.length);
    expect(serverChecks.map(({ detail }) => detail).join(" ")).toMatch(/threenative-assets/);
    expect(serverChecks.map(({ detail }) => detail).join(" ")).toMatch(/threenative-sculpt/);
    expect(serverChecks.map(({ detail }) => detail).join(" ")).toMatch(/threenative-engine/);
  });

  it("fails a resolved MCP server whose transport does not initialize", () => {
    const report = diagnoseProject(
      snapshot({
        mcpServerHealth: new Map([
          [
            "threenative-engine",
            { detail: "its MCP transport failed to start: boom", status: "fail" },
          ],
        ]),
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
        resolvePackageDirectory: (name) => (name === "@threenative/core" ? "/engine" : undefined),
      }),
    );
    const engine = report.checks.find(({ name }) => name.includes("@threenative/core"));
    expect(engine).toMatchObject({ status: "fail" });
    expect(engine?.detail).toContain("transport failed to start");
  });

  it("reports malformed capability configuration distinctly", () => {
    const report = diagnoseProject(
      snapshot({
        readText: (relative) => (relative === ".mcp.json" ? "{not-json" : "export default {}"),
      }),
    );
    expect(check(report, "capability search")).toMatchObject({ status: "fail" });
    expect(check(report, "capability search").detail).toMatch(/malformed|invalid JSON/u);
  });

  it("warns before a native build when compiled assets target mobile", () => {
    const report = diagnoseProject(
      snapshot({
        config: {
          nativeEntry: "src/game.ts",
          assets: {
            models: {},
            textures: { overrides: [{ codec: "etc1s", glob: "**/*.png" }] },
          },
        },
        packageJson: {
          ...(HEALTHY.packageJson as Record<string, unknown>),
          scripts: { "build:ios": "threenative build --target ios" },
        },
      }),
    );
    expect(check(report, "asset pipeline")).toMatchObject({ status: "warn" });
    expect(check(report, "asset pipeline").detail).toMatch(
      /TN_NATIVE_KTX2_UNSUPPORTED.*TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED/u,
    );
  });

  it("warns when mobile targets use the default asset passes", () => {
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/game.ts" },
        packageJson: {
          ...(HEALTHY.packageJson as Record<string, unknown>),
          scripts: { "build:ios": "threenative build --target ios" },
        },
      }),
    );

    expect(check(report, "asset pipeline")).toMatchObject({ status: "warn" });
    expect(check(report, "asset pipeline").detail).toMatch(
      /TN_NATIVE_KTX2_UNSUPPORTED.*TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED/u,
    );
  });

  it("follows the Android engine: V8 admits the default passes, QuickJS warns", () => {
    const android = () =>
      diagnoseProject(
        snapshot({
          config: { nativeEntry: "src/game.ts" },
          packageJson: {
            ...(HEALTHY.packageJson as Record<string, unknown>),
            scripts: { "build:android": "threenative build --target android" },
          },
        }),
      );
    vi.stubEnv("THREENATIVE_GRADLE_ARGS", "-PthreenativeJsEngine=v8");
    expect(check(android(), "asset pipeline")).toMatchObject({ status: "ok" });
    vi.stubEnv("THREENATIVE_GRADLE_ARGS", "-PthreenativeJsEngine=quickjs");
    expect(check(android(), "asset pipeline").detail).toMatch(
      /TN_NATIVE_KTX2_UNSUPPORTED.*android.*TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED/u,
    );
    vi.unstubAllEnvs();
  });

  it("warns for an omitted asset pass in a partial mobile config", () => {
    const report = diagnoseProject(
      snapshot({
        config: { nativeEntry: "src/game.ts", assets: { textures: "none" } },
        packageJson: {
          ...(HEALTHY.packageJson as Record<string, unknown>),
          scripts: { "build:ios": "threenative build --target ios" },
        },
      }),
    );

    expect(check(report, "asset pipeline")).toMatchObject({ status: "warn" });
    expect(check(report, "asset pipeline").detail).toContain(
      "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED",
    );
    expect(check(report, "asset pipeline").detail).not.toContain("TN_NATIVE_KTX2_UNSUPPORTED");
  });

  it("keeps explicit mobile asset opt-outs green", () => {
    const report = diagnoseProject(
      snapshot({
        config: {
          nativeEntry: "src/game.ts",
          assets: { models: "none", textures: "none" },
        },
        packageJson: {
          ...(HEALTHY.packageJson as Record<string, unknown>),
          scripts: { "build:android": "threenative build --target android" },
        },
      }),
    );

    expect(check(report, "asset pipeline")).toMatchObject({ status: "ok" });
  });

  it("uses the native build's KTX2 error name for the matching doctor warning", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-native-assets-");
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(
      path.join(root, "public", "assets.manifest.json"),
      JSON.stringify({ entries: { "hero.png": { output: "hero.ktx2" } } }),
    );
    await expect(assertNativeAssetsCompatible(root, "ios", {} as never)).rejects.toThrow(
      /TN_NATIVE_KTX2_UNSUPPORTED/u,
    );
  });

  it("warns with the asset path when a download directory cannot be written", () => {
    const report = diagnoseProject(
      snapshot({
        projectRoot: "/tmp/tn-doctor-assets",
        directoryWritable: (relative: string) => relative !== "public/assets",
      } as never),
    );
    expect(check(report, "asset pipeline")).toMatchObject({ status: "warn" });
    expect(check(report, "asset pipeline").detail).toMatch(/public\/assets/u);
  });

  it("reports the playtest runner as missing rather than passing", () => {
    const report = diagnoseProject(
      snapshot({ projectRoot: "/tmp/tn-doctor-playtest", playtestRunnerPath: undefined } as never),
    );
    expect(check(report, "playtest")).toMatchObject({ status: "fail" });
    expect(check(report, "playtest").detail).toMatch(
      /threenative-playtest|@threenative\/playtest/u,
    );
  });

  it("folds the installed playtest doctor result under the playtest heading", () => {
    const report = diagnoseProject(
      snapshot({
        projectRoot: "/tmp/tn-doctor-playtest",
        playtestRunnerPath: "/tmp/tn-doctor-playtest/node_modules/.bin/threenative-playtest",
        runPlaytestDoctor: () => "✓ node: v20.19.6\n✓ chromium: installed",
      } as never),
    );
    expect(check(report, "playtest")).toMatchObject({ status: "ok" });
    expect(check(report, "playtest").detail).toMatch(/chromium.*installed/u);
  });

  it("keeps diagnostics when the delegated playtest doctor exits with output", () => {
    const report = diagnoseProject(
      snapshot({
        projectRoot: "/tmp/tn-doctor-playtest",
        playtestRunnerPath: "/tmp/tn-doctor-playtest/node_modules/.bin/threenative-playtest",
        runPlaytestDoctor: () => {
          throw Object.assign(new Error("runner exited with code 1"), {
            stderr: Buffer.from("stderr blocker"),
            stdout: "stdout context",
          });
        },
      } as never),
    );
    expect(check(report, "playtest")).toMatchObject({ status: "fail" });
    expect(check(report, "playtest").detail).toContain("stderr blocker");
    expect(check(report, "playtest").detail).toContain("stdout context");
  });

  it("executes a POSIX playtest runner directly", () => {
    const runner = "/tmp/tn-doctor-playtest/node_modules/.bin/threenative-playtest";
    execFileSyncMock.mockReturnValue("runner output");
    const report = diagnoseProject(
      snapshot({ projectRoot: "/tmp/tn-doctor-playtest", playtestRunnerPath: runner } as never),
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      runner,
      ["doctor", "--text"],
      expect.objectContaining({
        cwd: "/tmp/tn-doctor-playtest",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(check(report, "playtest").detail).toContain("runner output");
  });

  it("forwards the same launch capture through project doctor", () => {
    const runner = "/tmp/tn-doctor-playtest/node_modules/.bin/threenative-playtest";
    execFileSyncMock.mockReturnValue("pipeline census — complete (native)");
    const report = diagnoseProject(
      snapshot({ projectRoot: "/tmp/tn-doctor-playtest", playtestRunnerPath: runner } as never),
      { capturePath: "artifacts/town.log" },
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      runner,
      ["doctor", "--text", "--capture", "artifacts/town.log"],
      expect.objectContaining({ cwd: "/tmp/tn-doctor-playtest" }),
    );
    expect(check(report, "playtest").detail).toContain("pipeline census");
  });

  it("executes a Windows .cmd playtest shim through cmd.exe and preserves diagnostics", () => {
    const runner = "C:\\game\\node_modules\\.bin\\threenative-playtest.cmd";
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("runner failed"), {
        stderr: Buffer.from("stderr blocker"),
        stdout: "stdout context",
      });
    });

    const report = withPlatform("win32", () =>
      diagnoseProject(snapshot({ projectRoot: "C:\\game", playtestRunnerPath: runner } as never)),
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", `"${runner}" doctor --text`],
      expect.objectContaining({
        cwd: "C:\\game",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(check(report, "playtest").detail).toContain("stderr blocker");
    expect(check(report, "playtest").detail).toContain("stdout context");
  });

  it("does not add a runtime dependency on the playtest package", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    expect(manifest.dependencies?.["@threenative/playtest"]).toBeUndefined();
  });

  it("names the Android JDK and SDK before a native build", () => {
    const report = diagnoseProject(
      snapshot({
        projectRoot: "/tmp/tn-doctor-toolchain",
        androidToolchain: { jdkMajor: 21, jdkVersion: "21.0.1", sdkVersion: "35.0.0" },
      } as never),
    );
    expect(check(report, "target android").detail).toMatch(/JDK 21\.0\.1.*17/u);
    expect(check(report, "target android").status).toBe("warn");
    expect(check(report, "target android").detail).not.toContain("checked by build");
    expect(check(report, "target android").fix).toMatch(/Install Android SDK platform android-36/u);
    expect(check(report, "target android").fix).toMatch(/ANDROID_HOME|ANDROID_SDK_ROOT/u);
    expect(check(report, "target android").fix).not.toContain("THREENATIVE_ANDROID_SDK");
    expect(formatDoctorReport(report)).toMatch(
      /fix: Install Android SDK platform android-36 and JDK 17/u,
    );
  });

  it("uses JAVA_HOME, not THREENATIVE_JAVA_HOME, for the Android JDK probe", () => {
    const buildJavaHome = "/build-jdk";
    const doctorOnlyJavaHome = "/doctor-only-jdk";
    const buildJava = path.join(
      buildJavaHome,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    );
    spawnSyncMock.mockImplementation((command: string) => ({
      stderr: `openjdk version "${command === buildJava ? "17.0.1" : "21.0.1"}"`,
      stdout: "",
      status: 0,
    }));

    const probe = probeAndroidToolchain({
      JAVA_HOME: buildJavaHome,
      THREENATIVE_JAVA_HOME: doctorOnlyJavaHome,
    });

    expect(probe).toMatchObject({ jdkMajor: 17, jdkVersion: "17.0.1" });
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(buildJava);
  });

  it("prefers the standard Android SDK variable over the custom doctor-only variable", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-conflicting-sdk-");
    const packagerSdk = path.join(root, "packager-sdk");
    const doctorOnlySdk = path.join(root, "doctor-only-sdk");
    for (const [sdk, revision] of [
      [packagerSdk, "35.0.0"],
      [doctorOnlySdk, "34.0.0"],
    ] as const) {
      const platform = path.join(sdk, "platforms", "android-36");
      await mkdir(platform, { recursive: true });
      await writeFile(path.join(platform, "source.properties"), `Pkg.Revision = ${revision}\n`);
    }

    const probe = probeAndroidToolchain({
      ANDROID_HOME: packagerSdk,
      THREENATIVE_ANDROID_SDK: doctorOnlySdk,
    });

    expect(probe.sdkVersion).toBe("35.0.0");
  });

  it("groups craft, test, and ship checks in the human-readable report", () => {
    const output = formatDoctorReport(diagnoseProject(HEALTHY));
    expect(output).toMatch(/Craft/);
    expect(output).toMatch(/Test/);
    expect(output).toMatch(/Ship/);
  });

  it("fails when the native runtime install recorded a failure", () => {
    const report = diagnoseProject(
      snapshot({
        readRuntimeText: () =>
          JSON.stringify({
            key: `${process.platform}-${process.arch}`,
            ok: false,
            reason:
              "Prebuilt release manifest fetch failed at https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.4.0/prebuilt-lock.json: HTTP 404.",
          }),
      }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "native runtime").status).toBe("fail");
    expect(check(report, "native runtime").detail).toMatch(/linux-x64|native runtime/u);
    expect(check(report, "native runtime").detail).toMatch(/HTTP 404/u);
  });

  it("fails when the recorded native runtime binary is gone", () => {
    const report = diagnoseProject(snapshot({ runtimeFileExists: () => false }));
    expect(report.pass).toBe(false);
    expect(check(report, "native runtime").detail).toMatch(/prebuilt binary.*gone|missing/u);
  });

  it("reports an unknown native state when the install status file is deleted", () => {
    const report = diagnoseProject(snapshot({ readRuntimeText: () => undefined }));
    expect(check(report, "native runtime")).toMatchObject({ status: "warn" });
    expect(check(report, "native runtime").detail).toMatch(/unknown.*install status/u);
  });

  it("lists web, desktop, Android, and iOS target availability", () => {
    const report = diagnoseProject(HEALTHY);
    for (const target of ["web", "desktop", "android", "ios"])
      expect(check(report, `target ${target}`).detail).toMatch(/available|unavailable/u);
    expect(check(report, "target web").status).toBe("ok");
    expect(check(report, "target desktop").status).toBe("ok");
    expect(check(report, "target android").status).toBe("ok");
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(check(report, "target ios").status).toBe("ok");
    } else {
      expect(check(report, "target ios")).toMatchObject({ status: "warn" });
      expect(check(report, "target ios").detail).toMatch(/requires darwin-arm64.*received/u);
    }
  });

  it("fails when install status belongs to a stale runtime version", () => {
    const report = diagnoseProject(
      snapshot({
        readRuntimeText: () =>
          JSON.stringify({
            key: `${process.platform}-${process.arch}`,
            ok: true,
            reason: "installed",
            url: "https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.3.9/prebuilt-lock.json",
            version: "0.3.9",
          }),
      }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "native runtime").detail).toMatch(/version.*0\.3\.9.*0\.4\.0/u);
  });

  it("fails when install status names a stale release URL", () => {
    const report = diagnoseProject(
      snapshot({
        readRuntimeText: () =>
          JSON.stringify({
            key: `${process.platform}-${process.arch}`,
            ok: true,
            reason: "installed",
            url: "https://example.invalid/runtime-native-v0.4.0/prebuilt-lock.json",
            version: "0.4.0",
          }),
      }),
    );
    expect(report.pass).toBe(false);
    expect(check(report, "native runtime").detail).toMatch(/release URL.*example\.invalid/u);
  });

  it("reports the last APK attribution total when its evidence is present", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-apk-size-");
    const recordPath = "docs/verification/apk-size-2026-08-25.md";
    const artifactPath =
      "packages/runtime-native/android/app/build/outputs/apk/debug/app-debug.apk";
    const buildDirectory = "packages/runtime-native/android/app/build";
    await mkdir(path.join(root, path.dirname(recordPath)), { recursive: true });
    await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
    await writeFile(path.join(root, artifactPath), Buffer.alloc(123));
    await writeFile(
      path.join(root, recordPath),
      [
        "# APK size attribution",
        "",
        "- Rebuilt APK bytes: **123**",
        `- APK artifact: \`${artifactPath}\``,
        `- Build directory: \`${buildDirectory}\``,
        `- APK SHA-256: \`${APK_SHA256}\``,
        "",
      ].join("\n"),
    );
    const report = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, recordPath]),
        projectRoot: root,
        readText: (relative) =>
          relative === recordPath
            ? "# APK size attribution\n\n- Rebuilt APK bytes: **123**\n- APK artifact: `packages/runtime-native/android/app/build/outputs/apk/debug/app-debug.apk`\n- Build directory: `packages/runtime-native/android/app/build`\n- APK SHA-256: `409a7f83ac6b31dc8c77e3ec18038f209bd2f545e0f4177c2e2381aa4e067b49`\n"
            : relative === "src/game.ts"
              ? "export default defineGame({})"
              : "",
      }),
    );

    expect(check(report, "APK size")).toMatchObject({ status: "ok" });
    expect(check(report, "APK size").detail).toContain("123 bytes");
  });

  it("warns when a replaced APK keeps the recorded byte count but has a different hash", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-apk-size-replaced-");
    const recordPath = "docs/verification/apk-size-2026-08-25.md";
    const artifactPath =
      "packages/runtime-native/android/app/build/outputs/apk/debug/app-debug.apk";
    const buildDirectory = "packages/runtime-native/android/app/build";
    await mkdir(path.join(root, path.dirname(recordPath)), { recursive: true });
    await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
    await writeFile(path.join(root, artifactPath), Buffer.alloc(123, 1));
    await writeFile(
      path.join(root, recordPath),
      [
        "# APK size attribution",
        "",
        "- Rebuilt APK bytes: **123**",
        `- APK artifact: \`${artifactPath}\``,
        `- Build directory: \`${buildDirectory}\``,
        `- APK SHA-256: \`${APK_SHA256}\``,
        "",
      ].join("\n"),
    );
    const report = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, recordPath]),
        projectRoot: root,
        readText: (relative) =>
          relative === recordPath
            ? `# APK size attribution\n\n- Rebuilt APK bytes: **123**\n- APK artifact: \`${artifactPath}\`\n- Build directory: \`${buildDirectory}\`\n- APK SHA-256: \`${APK_SHA256}\`\n`
            : relative === "src/game.ts"
              ? "export default defineGame({})"
              : "",
      }),
    );

    expect(check(report, "APK size")).toMatchObject({ status: "warn" });
    expect(check(report, "APK size").detail).toMatch(/SHA-256|hash/u);
    expect(check(report, "APK size").detail).not.toContain("123 bytes");
  });

  it("names missing APK evidence without presenting the recorded total as current", () => {
    const recordPath = "docs/verification/apk-size-2026-08-25.md";
    const report = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, recordPath]),
        projectRoot: "/tmp/tn-doctor-apk-size-missing",
        readText: (relative) =>
          relative === recordPath
            ? "# APK size attribution\n\n- Rebuilt APK bytes: **123**\n- APK artifact: `packages/runtime-native/android/app/build/outputs/apk/debug/app-debug.apk`\n- Build directory: `packages/runtime-native/android/app/build`\n- APK SHA-256: `409a7f83ac6b31dc8c77e3ec18038f209bd2f545e0f4177c2e2381aa4e067b49`\n"
            : relative === "src/game.ts"
              ? "export default defineGame({})"
              : "",
      }),
    );

    expect(check(report, "APK size")).toMatchObject({ status: "warn" });
    expect(check(report, "APK size").detail).toMatch(/missing evidence|build directory/u);
    expect(check(report, "APK size").detail).not.toContain("123 bytes");
  });
});

describe("threenative doctor command", () => {
  it("loads the shipped TypeScript config before deciding whether to probe the web overlay", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-config-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "doctor-config", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { nativeEntry: "src/game.ts", ui: { renderer: "web" } };\n',
    );

    const snapshot = await readProject(root);

    expect(snapshot.config).toMatchObject({ ui: { renderer: "web" } });
    expect(snapshot.desktopOverlay).toBeDefined();
  });

  it("keeps the TypeScript config authoritative over conflicting legacy surfaces", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-config-precedence-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "doctor-config-precedence",
        type: "module",
        threenative: { nativeEntry: "src/package-game.ts" },
      }),
    );
    await writeFile(
      path.join(root, "threenative.config.json"),
      JSON.stringify({ nativeEntry: "src/legacy-game.ts", ui: { renderer: "native" } }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { ui: { renderer: "web" } };\n',
    );

    const snapshot = await readProject(root);

    expect(snapshot.config).toMatchObject({
      nativeEntry: "src/package-game.ts",
      ui: { renderer: "web" },
    });
  });

  it("does not fall back to legacy config when the TypeScript config is invalid", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-config-invalid-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "doctor-config-invalid",
        type: "module",
        threenative: { nativeEntry: "src/package-game.ts" },
      }),
    );
    await writeFile(
      path.join(root, "threenative.config.json"),
      JSON.stringify({ nativeEntry: "src/legacy-game.ts", ui: { renderer: "native" } }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      "export default { app: { name: 42 } };\n",
    );

    const snapshot = await readProject(root);

    expect(snapshot.config).toBeUndefined();
  });

  it("does not report a threenative.config.json surface that builds ignore", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-config-json-only-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "doctor-config-json-only", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.json"),
      JSON.stringify({ nativeEntry: "src/legacy-game.ts", ui: { renderer: "native" } }),
    );

    const snapshot = await readProject(root);

    expect(snapshot.config).toBeUndefined();
  });

  it("keeps the sanctioned package.json nativeEntry fallback when no TypeScript config exists", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-config-package-entry-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "doctor-config-package-entry",
        type: "module",
        threenative: { nativeEntry: "src/package-game.ts" },
      }),
    );

    const snapshot = await readProject(root);

    expect(snapshot.config).toEqual({ nativeEntry: "src/package-game.ts" });
  });

  it("reads a real directory and exits 1 when that directory is not a project", async () => {
    const { runDoctorCommand } = await import("../src/threenative.js");
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const empty = await makeTempDir("tn-doctor-");
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let exitCode: number;
    try {
      exitCode = await runDoctorCommand([], empty);
    } finally {
      process.stdout.write = write;
    }
    expect(exitCode).toBe(1);
    expect(JSON.parse(written.join("")).pass).toBe(false);
  });

  it("names doctor in the top-level help", async () => {
    const { cliHelp } = await import("../src/threenative.js");
    expect(cliHelp()).toMatch(/doctor/);
    expect(cliHelp("doctor")).toMatch(/Exits 0 when nothing failed/);
  });
});

describe("threenative doctor edge coverage", () => {
  it("reports every compositor probe outcome, including a missing display and python3", () => {
    expect([undefined, false, true]).toContain(detectX11Compositor());

    execFileSyncMock.mockReturnValueOnce("1\n");
    expect(detectX11Compositor({ DISPLAY: ":99" })).toBe(true);
    execFileSyncMock.mockReturnValueOnce("0\n");
    expect(detectX11Compositor({ DISPLAY: ":99" })).toBe(false);
    // The shim prints `unknown` when it cannot measure; that is not a false "no compositor".
    execFileSyncMock.mockReturnValueOnce("unknown\n");
    expect(detectX11Compositor({ DISPLAY: ":99" })).toBeUndefined();
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("python3 missing"), { code: "ENOENT" });
    });
    expect(detectX11Compositor({ DISPLAY: ":99" })).toBeUndefined();
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("python3 failed"), { code: "EPIPE" });
    });
    expect(detectX11Compositor({ DISPLAY: ":99" })).toBeUndefined();
  });

  it("distinguishes an unprobed, healthy, and unknown desktop overlay", () => {
    expect(probeDesktopOverlay({})).toMatchObject({ status: "warn" });
    expect(probeDesktopOverlay({ DISPLAY: ":99" }, () => true)).toMatchObject({ status: "ok" });
    expect(probeDesktopOverlay({ DISPLAY: ":99" }, () => undefined)).toMatchObject({
      status: "warn",
    });
    expect(probeDesktopOverlay({ XDG_SESSION_TYPE: "wayland" }, () => true)).toMatchObject({
      status: "fail",
    });
    expect(
      probeDesktopOverlay({ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }, () => false),
    ).toMatchObject({ status: "ok" });
  });

  it("handles empty manifests and configured target arrays and strings", () => {
    // Android QuickJS lacks both decoders, so both mobile targets must appear in the warning.
    vi.stubEnv("THREENATIVE_GRADLE_ARGS", "-PthreenativeJsEngine=quickjs");
    const report = diagnoseProject(
      snapshot({
        config: {
          nativeEntry: "src/game.ts",
          nativeTargets: "ios",
          targets: ["android", "desktop", 7],
        },
        files: new Set(["package.json", "src/game.ts"]),
        installedVersions: new Map(),
        packageJson: {
          scripts: {
            android: "threenative build --target android",
            invalid: 7,
            web: "threenative build --target=web",
          },
          dependencies: { three: "0.185.1" },
        },
        readRuntimeText: undefined,
        runtimeRoot: undefined,
      }),
    );

    expect(check(report, "dependencies")).toMatchObject({
      detail: "no @threenative packages declared",
      status: "ok",
    });
    expect(check(report, "versions")).toMatchObject({ detail: "nothing installed to compare" });
    expect(check(report, "asset pipeline").detail).toMatch(/android.*ios|ios.*android/u);
    vi.unstubAllEnvs();
  });

  it("rejects unreadable, malformed, and hand-edited MCP configuration", () => {
    const unreadable = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, ".mcp.json"]),
        readText: () => undefined,
      }),
    );
    expect(check(unreadable, "capability search")).toMatchObject({ status: "fail" });

    const wrongRoot = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, ".mcp.json"]),
        readText: () => JSON.stringify({ mcpServers: [] }),
      }),
    );
    expect(check(wrongRoot, "capability search").detail).toMatch(/mcpServers/u);

    const missingServer = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, ".mcp.json"]),
        readText: () => JSON.stringify({ mcpServers: {} }),
      }),
    );
    expect(check(missingServer, "capability search").status).toBe("fail");

    const edited = diagnoseProject(
      snapshot({
        files: new Set([...HEALTHY.files, ".mcp.json"]),
        readText: () =>
          JSON.stringify({
            mcpServers: {
              "threenative-assets": {
                args: ["./node_modules/@threenative/core/mcp/assets.mjs"],
                command: "node",
              },
            },
          }),
      }),
    );
    expect(edited.checks.find(({ name }) => name.includes("threenative-asset-mcp"))).toMatchObject({
      status: "fail",
    });
  });

  it("pins every MCP server at the version @threenative/core actually installs", async () => {
    const core = JSON.parse(await readFile(path.resolve("packages/core/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      version: string;
    };
    for (const spec of MCP_SERVER_SPECS) {
      const declared =
        spec.packageName === "@threenative/core"
          ? core.version
          : core.dependencies?.[spec.packageName];
      expect(declared, spec.packageName).toBeDefined();
      // An in-repo server is declared with the workspace protocol, which pnpm rewrites to that
      // package's real version at publish time. That version is what an installed project gets,
      // so it is the one doctor must pin.
      const installed = declared?.startsWith("workspace:")
        ? await workspaceVersion(spec.packageName)
        : declared;
      expect(spec.version, spec.packageName).toBe(installed);
    }
  });

  it("checks resolved MCP package versions, including missing metadata and mismatches", async () => {
    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const root = await makeTempDir("tn-doctor-mcp-versions-");
    // Derived from the specs doctor actually checks, so a fourth server does not silently leave
    // this fixture describing a project that resolves one package fewer than doctor probes.
    const packageNames = MCP_SERVER_SPECS.map((spec) => [spec.packageName, spec.version] as const);
    for (const [name, version] of packageNames) {
      const directory = path.join(root, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ version }));
    }
    const resolver = (name: string) => path.join(root, "node_modules", name);
    const resolved = diagnoseProject(
      snapshot({
        projectRoot: undefined,
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
        resolvePackageDirectory: resolver,
      }),
    );
    expect(check(resolved, "capability search")).toMatchObject({ status: "ok" });

    await writeFile(
      path.join(root, "node_modules", "@threenative/core", "package.json"),
      JSON.stringify({}),
    );
    const noVersion = diagnoseProject(
      snapshot({
        projectRoot: undefined,
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
        resolvePackageDirectory: resolver,
      }),
    );
    expect(noVersion.checks.find(({ name }) => name.includes("@threenative/core"))).toMatchObject({
      status: "fail",
    });

    await writeFile(
      path.join(root, "node_modules", "@threenative/core", "package.json"),
      JSON.stringify({ version: "9.9.9" }),
    );
    const mismatch = diagnoseProject(
      snapshot({
        projectRoot: undefined,
        readText: (relative) => (relative === ".mcp.json" ? MCP_CONFIG : "export default {}"),
        resolvePackageDirectory: resolver,
      }),
    );
    expect(mismatch.checks.find(({ name }) => name.includes("@threenative/core"))).toMatchObject({
      status: "warn",
    });
  });

  it("covers writable asset directories and a readable mobile toolchain", () => {
    const report = diagnoseProject(
      snapshot({
        config: {
          assets: { models: "none", textures: "none" },
          nativeEntry: "src/game.ts",
          targets: ["android"],
        },
        directoryWritable: () => true,
        packageJson: { scripts: {} },
      }),
    );
    expect(check(report, "asset pipeline")).toMatchObject({ status: "ok" });

    const toolchain = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.1", sdkVersion: "35.0.0" },
        config: { nativeEntry: "src/game.ts", targets: ["android"] },
      }),
    );
    expect(check(toolchain, "target android")).toMatchObject({ status: "ok" });
    expect(check(toolchain, "target android").fix).toBeUndefined();
  });

  it("fails closed for every native runtime status boundary", () => {
    const noInstall = nativeRuntimeCheck(
      snapshot({
        runtimeRoot: undefined,
        readRuntimeText: undefined,
        installedVersions: new Map(),
      }),
    );
    expect(noInstall).toMatchObject({ status: "warn" });

    const unresolved = nativeRuntimeCheck(
      snapshot({
        runtimeRoot: undefined,
        readRuntimeText: undefined,
        installedVersions: new Map([["@threenative/runtime-native", "0.4.0"]]),
      }),
    );
    expect(unresolved).toMatchObject({ status: "fail" });

    const status = (value: unknown, overrides: Partial<IProjectSnapshot> = {}) =>
      nativeRuntimeCheck(
        snapshot({
          readRuntimeText: () => JSON.stringify(value),
          runtimeFileExists: () => true,
          ...overrides,
        }),
      );
    expect(status("not an object")).toMatchObject({ status: "fail" });
    expect(status(["not", "an", "object"])).toMatchObject({ status: "fail" });
    expect(status({ ok: false })).toMatchObject({ status: "fail" });
    expect(status({ ok: true })).toMatchObject({ status: "fail" });
    expect(
      status({
        key: "other-platform",
        ok: true,
        url: HEALTHY.runtimeManifestUrl,
        version: "0.4.0",
      }),
    ).toMatchObject({ status: "fail" });
    expect(
      status(
        {
          key: `${process.platform}-${process.arch}`,
          ok: true,
          url: HEALTHY.runtimeManifestUrl,
          version: "0.4.0",
        },
        { runtimeManifestUrl: undefined },
      ),
    ).toMatchObject({ status: "fail" });

    const win32 = withPlatform("win32", () =>
      status(
        {
          key: `win32-${process.arch}`,
          ok: true,
          url: HEALTHY.runtimeManifestUrl,
          version: "0.4.0",
        },
        { runtimeFileExists: (relative) => relative.endsWith(".exe") },
      ),
    );
    expect(win32).toMatchObject({ status: "ok" });
  });

  it("fails closed when the installed host is older than the engine it must satisfy", () => {
    const host = (nativeHost: { readonly reason?: string; readonly runtimeVersion?: string }) =>
      nativeRuntimeCheck(snapshot({ nativeHost }));

    // The published `runtime-native-v0.3.2` prebuilt answered exactly this, under a package whose
    // own version said 0.4.0, and every desktop binary built with it showed no UI.
    const stale = host({ runtimeVersion: "0.3.0" });
    expect(stale).toMatchObject({ status: "fail" });
    expect(stale.detail).toContain("runtime v0.3.0");
    expect(stale.detail).toContain("older than the installed engine 0.4.0");
    expect(stale.fix).toContain("native:build");

    // A host that will not say what it is cannot be vouched for, and silence is the one shape the
    // stale prebuilt could take without lying.
    const silent = host({ reason: "spawn threenative-runtime ENOENT" });
    expect(silent).toMatchObject({ status: "fail" });
    expect(silent.detail).toContain("did not report a runtime version");
    expect(silent.detail).toContain("ENOENT");

    // A prerelease of the required release is still older than it.
    expect(host({ runtimeVersion: "0.4.0-rc.1" })).toMatchObject({ status: "fail" });

    // Equal or newer is the whole passing set, and the detail names the host it read.
    expect(host({ runtimeVersion: "0.4.0" })).toMatchObject({
      detail: `available (${process.platform}-${process.arch}, host runtime v0.4.0)`,
      status: "ok",
    });
    expect(host({ runtimeVersion: "0.5.1" })).toMatchObject({ status: "ok" });

    // A version string that cannot be compared is not a pass: the string it has to protect against
    // is metadata that already disagreed with the binary once.
    expect(host({ runtimeVersion: "workspace:*" })).toMatchObject({ status: "fail" });
  });

  it("reads the host's own --version, and reports a host it cannot run", () => {
    execFileSyncMock.mockReturnValueOnce(
      'TN_COLD_START:{"segment":"process","atMs":0.000}\nMystral Native Runtime v0.3.2\nNative WebGPU JS runtime - dawn + v8 build\n',
    );
    expect(probeNativeHost("/runtime-native/prebuilt/linux-x64/threenative-runtime")).toEqual({
      runtimeVersion: "0.3.2",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/runtime-native/prebuilt/linux-x64/threenative-runtime",
      ["--version"],
      expect.objectContaining({ encoding: "utf8" }),
    );

    execFileSyncMock.mockReturnValueOnce("Mystral CLI - Native Runtime for Mystral Engine\n");
    expect(probeNativeHost("host-with-no-version").reason).toBe(
      "the host did not name its runtime version",
    );

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(probeNativeHost("missing-host").reason).toContain("ENOENT");
  });

  it("handles Java probe failures and legacy JDK output", async () => {
    spawnSyncMock.mockReturnValueOnce({ stderr: 'java version "1.8.0_392"', stdout: "" });
    expect(probeAndroidToolchain({ JAVA_HOME: "  " })).toMatchObject({
      jdkMajor: 8,
      jdkVersion: "1.8.0_392",
    });

    spawnSyncMock.mockReturnValueOnce({ stderr: "not a java version", stdout: "" });
    expect(probeAndroidToolchain({}).jdkMajor).toBeUndefined();

    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error("java unavailable");
    });
    expect(probeAndroidToolchain({}).jdkMajor).toBeUndefined();

    const { makeTempDir } = await import("../../../test-support/temp-dir.js");
    const sdk = await makeTempDir("tn-doctor-sdk-");
    await mkdir(path.join(sdk, "platforms", "android-36"), { recursive: true });
    await writeFile(path.join(sdk, "platforms", "android-36", "source.properties"), "Pkg.Name=x\n");
    spawnSyncMock.mockReturnValueOnce({ stderr: "not a java version", stdout: "" });
    expect(
      probeAndroidToolchain({ ANDROID_HOME: sdk, HOME: path.join(sdk, "no-home") }).sdkVersion,
    ).toBeUndefined();
  });
});

describe("threenative doctor and model conversion", () => {
  const ABSENT = {
    available: false,
    detail: "No Blender 4.2 or newer was found.",
    installCommand: "sudo snap install blender --classic",
  };

  it("should warn, not fail, when Blender is absent", () => {
    const report = diagnoseProject(snapshot({ blender: ABSENT }));
    const conversion = check(report, "model conversion");
    expect(conversion.status).toBe("warn");
    expect(conversion.fix).toContain("sudo snap install blender --classic");
    // The point of the whole check: a project with no importable source stays green.
    expect(conversion.detail).toContain("nothing needs it yet");
    expect(report.pass).toBe(true);
  });

  it("should say the transport was not probed rather than claiming it is up", () => {
    // Mutation-proofing: nothing pinned the unprobed branch, so reporting "transport is up" for a
    // server that was never probed passed the whole suite. The separation this phase exists for is
    // between a transport observed to work and one nobody looked at.
    const unprobed = diagnoseProject(snapshot({ blender: ABSENT }));
    expect(check(unprobed, "model conversion").detail).toContain("was not probed");
    expect(check(unprobed, "model conversion").detail).not.toContain("transport is up");
    const probed = diagnoseProject(
      snapshot({
        blender: ABSENT,
        mcpServerHealth: new Map([
          [
            BLENDER_SERVER,
            { detail: "transport initialized and advertised 3 tool(s)", status: "ok" as const },
          ],
        ]),
      }),
    );
    expect(check(probed, "model conversion").detail).toContain("transport is up");
    expect(check(probed, "model conversion").detail).not.toContain("was not probed");
  });

  it("should report conversion unavailable when the Blender MCP starts but Blender is missing", () => {
    const report = diagnoseProject(
      snapshot({
        blender: ABSENT,
        mcpServerHealth: new Map([
          [
            BLENDER_SERVER,
            { detail: "transport initialized and advertised 3 tool(s)", status: "ok" as const },
          ],
        ]),
      }),
    );
    const conversion = check(report, "model conversion");
    // The four facts stay four: a transport that is up, and a conversion that cannot happen.
    expect(conversion.detail).toContain("transport is up");
    expect(conversion.detail).toContain("conversion is unavailable");
    expect(conversion.status).toBe("warn");
    // And the server check must not be the place a reader learns the toolchain is complete.
    expect(check(report, "capability search").detail).toContain("transport only");
  });

  it("should fail when the Blender server's transport is down", () => {
    const report = diagnoseProject(
      snapshot({
        blender: ABSENT,
        mcpServerHealth: new Map([
          [
            BLENDER_SERVER,
            { detail: "its MCP transport failed to start: exited 1", status: "fail" as const },
          ],
        ]),
      }),
    );
    expect(check(report, "model conversion").status).toBe("fail");
    expect(check(report, "model conversion").detail).toContain("no conversion tool is reachable");
    expect(report.pass).toBe(false);
  });

  it("should report the version when Blender resolves", () => {
    const report = diagnoseProject(
      snapshot({
        blender: {
          available: true,
          detail: "Blender 5.2.0 at '/usr/bin/blender'.",
          installCommand: "sudo snap install blender --classic",
          version: "5.2.0",
        },
      }),
    );
    expect(check(report, "model conversion")).toMatchObject({ status: "ok" });
    expect(check(report, "model conversion").detail).toContain("5.2.0");
  });

  it("should never claim a conversion ran without the bake manifest saying so", () => {
    const available = {
      available: true,
      detail: "Blender 5.2.0 at '/usr/bin/blender'.",
      installCommand: "sudo snap install blender --classic",
      version: "5.2.0",
    };
    const withoutManifest = diagnoseProject(snapshot({ blender: available }));
    expect(check(withoutManifest, "model conversion").detail).toContain("no conversion is proven");

    const base = snapshot({ blender: available });
    const withManifest = diagnoseProject({
      ...base,
      files: new Set([...base.files, "public/assets.manifest.json"]),
      readText: (relative) =>
        relative === "public/assets.manifest.json"
          ? JSON.stringify({
              entries: [{ importedFrom: "fbx", path: "hero.glb" }, { path: "rock.glb" }],
            })
          : base.readText(relative),
    });
    expect(check(withManifest, "model conversion").detail).toContain("1 converted model(s)");
  });

  it("should name the sources that need Blender when the project carries them", () => {
    const base = snapshot({ blender: ABSENT });
    const report = diagnoseProject({
      ...base,
      files: new Set([...base.files, "assets/hero.fbx"]),
    });
    const conversion = check(report, "model conversion");
    expect(conversion.status).toBe("warn");
    expect(conversion.detail).toContain("assets/hero.fbx");
    // Still a warning: the hard failure belongs in the build, where the source is actually read.
    expect(report.pass).toBe(true);
  });

  it("should omit the check entirely when nothing probed for Blender", () => {
    const report = diagnoseProject(snapshot({}));
    expect(report.checks.some(({ name }) => name === "model conversion")).toBe(false);
  });
});

describe("threenative doctor and editor activation", () => {
  const hostFiles = MCP_HOST_TABLE.map(({ file }) => file);

  function wiredEverywhere(): IProjectSnapshot {
    const base = snapshot({});
    return {
      ...base,
      files: new Set([...base.files, ...hostFiles]),
      readText: (relative) => (hostFiles.includes(relative) ? MCP_CONFIG : base.readText(relative)),
    };
  }

  it("should count the host configs that carry the servers and stop short of claiming activation", () => {
    const activation = check(diagnoseProject(wiredEverywhere()), "editor activation");
    expect(activation.status).toBe("ok");
    expect(activation.detail).toContain(`${hostFiles.length} of ${hostFiles.length}`);
    // The fact doctor cannot observe is stated, not implied away.
    expect(activation.detail).toContain("not observable from here");
    expect(activation.detail).toContain("Windsurf");
  });

  it("should warn and name the exact file when a host config is unreadable", () => {
    const base = wiredEverywhere();
    const activation = check(
      diagnoseProject({
        ...base,
        readText: (relative) =>
          relative === ".vscode/mcp.json" ? "{ not json" : base.readText(relative),
      }),
      "editor activation",
    );
    expect(activation.status).toBe("warn");
    expect(activation.detail).toContain(".vscode/mcp.json is unreadable");
    // A config doctor cannot parse is still the user's: it says where, and never rewrites it.
    expect(activation.fix).toContain("never edits it");
  });

  it("should warn when a present host config is missing a declared server", () => {
    const base = wiredEverywhere();
    const partial = JSON.stringify({
      mcpServers: { "threenative-engine": { args: [], command: "node" } },
    });
    const activation = check(
      diagnoseProject({
        ...base,
        readText: (relative) =>
          relative === ".zed/settings.json" ? partial : base.readText(relative),
      }),
      "editor activation",
    );
    expect(activation.status).toBe("warn");
    expect(activation.detail).toContain(".zed/settings.json is missing ThreeNative servers");
  });

  it("should not contradict itself on a project wired for one host only", () => {
    // The defect: keyed to .mcp.json alone, capability search reported "no .mcp.json" and exited 1
    // beside an editor activation line that had just found the servers in .cursor/mcp.json.
    const base = snapshot({});
    const report = diagnoseProject({
      ...base,
      files: new Set(
        [...base.files].filter((file) => file !== ".mcp.json").concat(".cursor/mcp.json"),
      ),
      readText: (relative) =>
        relative === ".cursor/mcp.json" ? MCP_CONFIG : base.readText(relative),
    });
    expect(check(report, "editor activation").status).toBe("ok");
    // Cursor's table is fully diagnosed, not merely acknowledged: the per-server checks are the
    // proof, because the "some other host has it" fallback emits none of them.
    const perServer = report.checks.filter(({ name }) => name.startsWith("capability search: "));
    expect(perServer).toHaveLength(MCP_SERVER_SPECS.length);
    expect(check(report, "capability search").detail).toContain(".cursor/mcp.json");
    expect(check(report, "capability search").status).not.toBe("fail");
  });

  it("should name the host config it actually read in every per-server message", () => {
    // The defect: the summary named .cursor/mcp.json while each per-server line told the user to
    // restore an entry in .mcp.json — a file that does not exist in this project.
    const base = snapshot({});
    const withoutEngine = JSON.stringify({
      mcpServers: Object.fromEntries(
        Object.entries(
          (JSON.parse(MCP_CONFIG) as { mcpServers: Record<string, unknown> }).mcpServers,
        ).filter(([name]) => name !== MCP_SERVER_SPECS[0]?.configName),
      ),
    });
    const report = diagnoseProject({
      ...base,
      files: new Set(
        [...base.files].filter((file) => file !== ".mcp.json").concat(".cursor/mcp.json"),
      ),
      readText: (relative) =>
        relative === ".cursor/mcp.json" ? withoutEngine : base.readText(relative),
    });
    const missing = check(report, `capability search: ${MCP_SERVER_SPECS[0]?.packageName}`);
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain(".cursor/mcp.json");
    expect(missing.detail).not.toContain("from .mcp.json");
    expect(missing.fix).toContain(".cursor/mcp.json");
  });

  it("should diagnose the host config that carries the servers, not the first that parses", () => {
    // The defect: a user's own .mcp.json parsed first, so a project whose other hosts were
    // correctly wired reported "0 of 4 server(s) in .mcp.json resolve" beside "7 of 7 wired".
    const base = snapshot({});
    const report = diagnoseProject({
      ...base,
      files: new Set([...base.files, ".cursor/mcp.json"]),
      readText: (relative) =>
        relative === ".mcp.json"
          ? JSON.stringify({ mcpServers: { "my-own-server": { command: "node" } } })
          : relative === ".cursor/mcp.json"
            ? MCP_CONFIG
            : base.readText(relative),
    });
    const summary = check(report, "capability search");
    expect(summary.detail).toContain(".cursor/mcp.json");
    expect(summary.status).not.toBe("fail");
  });

  it("should warn rather than fail when only an unvalidatable host format is wired", () => {
    const base = snapshot({});
    const report = diagnoseProject({
      ...base,
      files: new Set(
        [...base.files].filter((file) => file !== ".mcp.json").concat(".zed/settings.json"),
      ),
      readText: (relative) =>
        relative === ".zed/settings.json" ? MCP_CONFIG : base.readText(relative),
    });
    const search = check(report, "capability search");
    expect(search.status).toBe("warn");
    expect(search.detail).toContain("Zed");
  });

  it("should rescue a malformed verifiable config when another host carries the servers", () => {
    // The same defect review 2 found on the `missing` branch, surviving on its sibling: the
    // `malformed` branch never got the "some other host carries them" rescue, so one unreadable
    // .mcp.json hard-failed a project whose Zed config was wired correctly.
    const base = snapshot({});
    const report = diagnoseProject({
      ...base,
      files: new Set([...base.files, ".zed/settings.json"]),
      readText: (relative) =>
        relative === ".mcp.json"
          ? "{ not json"
          : relative === ".zed/settings.json"
            ? MCP_CONFIG
            : base.readText(relative),
    });
    const search = check(report, "capability search");
    expect(search.status).toBe("warn");
    expect(search.detail).toContain("Zed");
    expect(search.detail).toContain(".mcp.json");
  });

  it("should fail, not warn, when every host config is broken", () => {
    // Inverted severity: counting broken files before counting working ones meant that corrupting
    // a config downgraded the report from fail to warn.
    const base = snapshot({});
    const files = new Set([...base.files, ...MCP_HOST_TABLE.map(({ file }) => file)]);
    const report = diagnoseProject({
      ...base,
      files,
      readText: (relative) =>
        MCP_HOST_TABLE.some(({ file }) => file === relative)
          ? "{ not json"
          : base.readText(relative),
    });
    const activation = check(report, "editor activation");
    expect(activation.status).toBe("fail");
    // And the audience with nothing working is the one that most needs the manual-setup sentence.
    expect(activation.detail).toContain("Windsurf");
  });

  it("should fail when no project-scoped host config carries the servers", () => {
    const base = snapshot({});
    const report = diagnoseProject({
      ...base,
      files: new Set([...base.files].filter((file) => !hostFiles.includes(file))),
    });
    expect(check(report, "editor activation").status).toBe("fail");
    expect(report.pass).toBe(false);
  });
});

describe("threenative doctor --target/--mode", () => {
  const BROKEN_RUNTIME_STATUS = JSON.stringify({
    key: `${process.platform}-${process.arch}`,
    ok: false,
    reason: "HTTP 404 downloading the prebuilt runtime",
    url: "https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v0.4.0/prebuilt-lock.json",
    version: "0.4.0",
  });

  const SIGNING_ENV: NodeJS.ProcessEnv = Object.fromEntries(
    ANDROID_RELEASE_SIGNING_ENV.map((name) => [name, "supplied"]),
  );

  it("should treat a blank signing input as missing, not as supplied", () => {
    // Round 7: `(environment[name] ?? "").trim().length === 0` was pinned by nothing. Every fixture
    // set all four names or none, so `environment[name] === undefined` passed all 91 tests — and
    // `environment` is the real `process.env` on a real run. A blank value is how a signing input
    // most often goes missing: `export ORG_GRADLE_PROJECT_threenativeKeystore=` in a CI job or a
    // .env file. Under that mutation doctor prints `buildable — android release` and exits 0 while
    // Gradle cannot sign, which is verbatim what acceptance criterion 1 forbids.
    for (const blank of ["", "   "]) {
      const report = diagnoseProject(
        snapshot({
          androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.19", sdkVersion: "35.0.0" },
          environment: Object.fromEntries(ANDROID_RELEASE_SIGNING_ENV.map((name) => [name, blank])),
        }),
        { mode: "release", target: "android" },
      );
      const requested = check(report, "requested build");
      expect(requested.status).toBe("fail");
      expect(requested.detail).toContain("release signing inputs are not set:");
      for (const name of ANDROID_RELEASE_SIGNING_ENV) expect(requested.detail).toContain(name);
    }
  });

  it("should fail the requested Android release when the JDK is unsupported", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" },
        environment: SIGNING_ENV,
      }),
      { mode: "release", target: "android" },
    );
    const requested = check(report, "requested build");
    expect(requested.status).toBe("fail");
    expect(requested.detail).toContain("not buildable");
    expect(requested.detail).toMatch(/JDK 26\.0\.2/u);
    expect(requested.fix).toMatch(/JDK 17/u);
    expect(report.pass).toBe(false);
  });

  it("should list only unmet requirements as blockers, never satisfied ones", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" },
        environment: SIGNING_ENV,
      }),
      { mode: "release", target: "android" },
    );
    const requested = check(report, "requested build");
    // The SDK is present. A met requirement is not a reason the build cannot start, and printing
    // it among the blockers makes the prediction unusable.
    expect(requested.detail).toMatch(/JDK 26\.0\.2/u);
    expect(requested.detail).not.toMatch(/android-36 .*found/u);
    // It stays in the standing target line, which reports every probed fact, met or not.
    expect(check(report, "target android").detail).toMatch(/android-36 .*found/u);
  });

  it("should name the blocker on the requested target line, not only satisfied probes", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" },
        environment: SIGNING_ENV,
      }),
      { mode: "release", target: "android" },
    );
    // The target line borrows the verdict's word, so it must also borrow the verdict's reason:
    // "not buildable — <every fact that is satisfied>" is the shape the PRD forbids. The probed
    // facts stay, but behind the blocker and labelled as probes.
    const target = check(report, "target android").detail;
    expect(target).toMatch(/^not buildable — JDK 26\.0\.2/u);
    expect(target).toContain("; probed: ");
    expect(target.slice(0, target.indexOf("; probed: "))).not.toMatch(/android-36/u);
    expect(target).toMatch(/probed: .*android-36 .*found/u);
  });

  it("should keep every blocker when one blocker contains a colon of its own", () => {
    // Round 6: `^not buildable — [^:]*: (?<why>.+)$` strips the `<scope>: ` prefix off the verdict.
    // Widen `[^:]*` to `.*` and it matches greedily to the LAST colon instead of the scope's, so
    // the line silently drops every blocker before the final one - and the release signing blocker
    // ends in a colon, so it is always the last. All 89 tests stayed green through that mutation.
    const report = diagnoseProject(
      snapshot({ androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" } }),
      { mode: "release", target: "android" },
    );
    const target = check(report, "target android").detail;
    const stated = target.slice(0, target.indexOf("; probed: "));
    // The signing blocker is last and carries its own colon; the JDK blocker precedes it. Both survive.
    expect(stated).toContain("JDK 26.0.2");
    expect(stated).toContain("release signing inputs are not set:");
    expect(stated).toContain("ORG_GRADLE_PROJECT_threenativeKeystore");
    // And the scope prefix the regex exists to remove is gone.
    expect(stated).not.toMatch(/^not buildable — android release: /u);
  });

  it("should give the requested target the requested build's fix, not the target's own", () => {
    // Round 6: `fix: requestedBuild.fix ?? check.fix` is unpinned. Inverted, 89 tests stay green
    // while the CLI prints the generic "install the SDK" advice instead of the one naming the
    // runtime reinstall and the signing exports - the actionable half this phase exists to make.
    const report = diagnoseProject(
      snapshot({ androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" } }),
      { mode: "release", target: "android" },
    );
    const requested = check(report, "requested build");
    expect(requested.fix).toBeDefined();
    expect(check(report, "target android").fix).toBe(requested.fix);
  });

  it("should block a requested desktop build on a failing overlay", () => {
    const overlay = {
      detail: "no X11 compositor, so the desktop UI overlay cannot start",
      fix: "Start a compositor.",
      status: "fail" as const,
    };
    const report = diagnoseProject(snapshot({ desktopOverlay: overlay }), { target: "desktop" });
    const requested = check(report, "requested build");
    expect(requested.status).toBe("fail");
    expect(requested.detail).toContain("overlay cannot start");
    expect(report.pass).toBe(false);
    // The desktop target line borrows the native runtime's `available (linux-x64)` wording rather
    // than the `available — …` the other targets use, and matching only the latter left this one
    // line still reading `available` beside the verdict above.
    const target = check(report, "target desktop");
    expect(target.status).toBe("fail");
    expect(target.detail).not.toMatch(/^available/u);
    expect(target.detail).toMatch(/^not buildable — .*overlay cannot start/u);
    // The desktop line's own facts are `available (linux-x64)`; the probe list must carry the key
    // itself, not the surviving parentheses, which read as a truncation.
    expect(target.detail).toMatch(/; probed: [^(]/u);
  });

  it("should not call the requested target available while its build cannot start", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" },
        environment: SIGNING_ENV,
      }),
      { mode: "release", target: "android" },
    );
    // The defect this PRD names: a line reading "available" beside a verdict of "not buildable".
    const target = check(report, "target android");
    expect(target.detail).not.toMatch(/^available/u);
    expect(target.detail).toContain("not buildable");
    expect(target.status).toBe("fail");
  });

  it("should fail the requested Android build when the runtime artifact never downloaded", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.1", sdkVersion: "35.0.0" },
        readRuntimeText: (relative) =>
          relative === "prebuilt/install-status.json" ? BROKEN_RUNTIME_STATUS : undefined,
      }),
      { target: "android" },
    );
    const requested = check(report, "requested build");
    expect(requested.status).toBe("fail");
    expect(requested.detail).toMatch(/HTTP 404/u);
    expect(report.pass).toBe(false);
  });

  it("should block a native build on a runtime that only warns, not just one that fails", () => {
    // Round 7, final hunt: `if (nativeRuntime.status !== "ok")` was pinned by nothing. Every
    // request-path fixture was either ok or a hard fail, so the boundary the code actually draws
    // went untested and `=== "fail"` passed all 92. "no install status recorded" is a *warn*: under
    // that mutation `examples/abyss-framework` prints `buildable — desktop` with no runtime
    // downloaded at all, which is the missing-download class of acceptance criterion 1 and the very
    // state this phase's observed-red control runs in.
    const report = diagnoseProject(
      // No install record and nothing resolved: `nativeRuntimeCheck` calls that `warn`, the same
      // shape as `examples/abyss-framework` on this machine.
      snapshot({
        runtimeRoot: undefined,
        readRuntimeText: undefined,
        installedVersions: new Map(),
      }),
      { target: "desktop" },
    );
    const runtime = check(report, "native runtime");
    expect(runtime.status).not.toBe("ok");
    expect(runtime.status).not.toBe("fail");
    const requested = check(report, "requested build");
    expect(requested.status).toBe("fail");
    expect(requested.detail).toContain(runtime.detail.replace(/^(?:unavailable|unknown) — /u, ""));
  });

  it("should name the missing Android packager, and read the Android file to decide it", () => {
    // Round 7, final hunt: nothing asserted this blocker at all - pointing the probe at
    // `scripts/package-ios.mjs` instead left all 92 green. The spec mentioned
    // `package-android.mjs` only in the fixture that makes it exist.
    const base = snapshot({
      androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.1", sdkVersion: "35.0.0" },
      environment: {},
    });
    const report = diagnoseProject(
      {
        ...base,
        // Only the Android packager is gone; the iOS one stays, so a probe reading the wrong file
        // sees nothing wrong.
        runtimeFileExists: (relative) =>
          relative === "scripts/package-android.mjs"
            ? false
            : (base.runtimeFileExists?.(relative) ?? false),
      },
      { mode: "debug", target: "android" },
    );
    const requested = check(report, "requested build");
    expect(requested.status).toBe("fail");
    expect(requested.detail).toContain("no Android packager");
  });

  it("should fail a requested Android release with no signing inputs and pass the same debug build", () => {
    const buildable = snapshot({
      androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.1", sdkVersion: "35.0.0" },
      environment: {},
    });
    const release = diagnoseProject(buildable, { mode: "release", target: "android" });
    expect(check(release, "requested build").status).toBe("fail");
    expect(check(release, "requested build").detail).toContain(ANDROID_RELEASE_SIGNING_ENV[0]);
    expect(release.pass).toBe(false);

    const debug = diagnoseProject(buildable, { mode: "debug", target: "android" });
    expect(check(debug, "requested build").status).toBe("ok");
    expect(check(debug, "requested build").detail).toContain("buildable");
    expect(debug.pass).toBe(true);

    // Round 7: `--mode` is half this phase's CLI surface and the scope label is the only place it
    // becomes visible, yet dropping the mode from that label left all 92 tests green — the two
    // predictions then read identically. The acceptance criteria quote the `android release`
    // spelling as their evidence, so it is asserted here rather than assumed.
    expect(check(release, "requested build").detail).toContain("android release");
    expect(check(debug, "requested build").detail).toContain("android debug");
  });

  it("should not demand iOS evidence for an Android request", () => {
    const report = diagnoseProject(
      snapshot({
        androidToolchain: { jdkMajor: 17, jdkVersion: "17.0.1", sdkVersion: "35.0.0" },
        environment: {},
      }),
      { mode: "debug", target: "android" },
    );
    expect(check(report, "requested build").status).toBe("ok");
    expect(check(report, "target ios").status).not.toBe("fail");
    expect(report.pass).toBe(true);
  });

  it("should keep a broken non-requested target from failing the requested one", () => {
    const report = diagnoseProject(
      snapshot({
        readRuntimeText: (relative) =>
          relative === "prebuilt/install-status.json" ? BROKEN_RUNTIME_STATUS : undefined,
      }),
      { target: "web" },
    );
    expect(check(report, "requested build").status).toBe("ok");
    expect(check(report, "target desktop").status).toBe("warn");
    // `native runtime` carries the same fact one level down, so demoting only the target line left
    // a web request exiting 1 on a broken desktop prebuilt — the help text promises the opposite.
    // The fact stays in the report; it stops voting, exactly like the target line above it.
    expect(check(report, "native runtime").status).toBe("warn");
    expect(check(report, "native runtime").detail).toMatch(/unavailable|unknown/u);
    expect(report.pass).toBe(true);
  });

  it("should not fail a web request on the native entry only a native build starts", () => {
    // `native entry` says so itself — "so a native build has nothing to start" — and a web build
    // starts src/main.ts. It was the last check still voting on a scoped exit code.
    const base = snapshot({});
    const missingEntry = {
      ...base,
      files: new Set([...base.files].filter((file) => file !== "src/game.ts")),
    };
    const web = diagnoseProject(missingEntry, { target: "web" });
    expect(check(web, "native entry").status).toBe("warn");
    expect(check(web, "requested build").status).toBe("ok");
    // Nothing else is red, so the exit code is the request's alone.
    expect(web.checks.filter(({ status }) => status === "fail").map(({ name }) => name)).toEqual(
      [],
    );
    expect(web.pass).toBe(true);
  });

  it("should name the missing native entry among a native build's blockers", () => {
    // The other direction of the same omission: the verdict line has to carry what stops the
    // build, or a supported JDK makes it read `buildable` on a project that cannot start.
    const base = snapshot({});
    const missingEntry = {
      ...base,
      files: new Set([...base.files].filter((file) => file !== "src/game.ts")),
    };
    const android = diagnoseProject(missingEntry, { target: "android" });
    expect(check(android, "requested build").status).toBe("fail");
    expect(check(android, "requested build").detail).toMatch(/nothing to start/u);
    expect(check(android, "native entry").status).toBe("fail");
    expect(android.pass).toBe(false);
  });

  it("should not fail a web request on the desktop overlay it never needs", () => {
    const overlay = {
      detail: "no compositor is running, so the desktop UI overlay cannot start",
      fix: "Start a compositor.",
      status: "fail" as const,
    };
    const overlayProject = {
      config: { nativeEntry: "src/game.ts", ui: { renderer: "web" } },
      desktopOverlay: overlay,
    };
    // Round 7: this asked only about web, so `desktop overlay`'s owner list was one target short
    // of the invariant it names. Adding "android" to that list left all 92 tests green while
    // `doctor --target android` exited 1 because a *desktop* overlay failed — review 4's defect
    // returning through the one door left open. Every non-owner is asked now.
    for (const target of ["web", "android", "ios"] as const) {
      const scoped = diagnoseProject(snapshot(overlayProject), { target });
      expect(check(scoped, "desktop overlay").status).toBe("warn");

      // And the overlay is never a reason the requested build cannot go ahead. (Android and iOS
      // may still fail this fixture on their own missing toolchains; that is their business.)
      expect(check(scoped, "requested build").detail).not.toContain("overlay");
    }
    const scoped = diagnoseProject(snapshot(overlayProject), { target: "web" });
    expect(check(scoped, "requested build").status).toBe("ok");
    // Ask for desktop and the same overlay decides the exit code again.
    const desktop = diagnoseProject(snapshot(overlayProject), { target: "desktop" });
    expect(check(desktop, "desktop overlay").status).toBe("fail");
    expect(desktop.pass).toBe(false);
    // Unscoped, nothing is demoted: the report is unchanged for everyone who did not ask.
    const unscoped = diagnoseProject(snapshot(overlayProject));
    expect(check(unscoped, "desktop overlay").status).toBe("fail");
    expect(unscoped.pass).toBe(false);
  });

  it("should let every native target own the native runtime, and only web demote it", () => {
    // The sibling of the `desktop overlay` owners bug, and only visible on a runtime that actually
    // fails: dropping "ios" from TARGET_PREREQUISITE_OWNERS["native runtime"] is severity drift -
    // the requested build still fails and the exit code is still 1 - but it is the same shape, and
    // it survived the suite. A resolved package with no runtime root is the failing case.
    const broken = snapshot({
      runtimeRoot: undefined,
      readRuntimeText: undefined,
      installedVersions: new Map([["@threenative/runtime-native", "0.4.0"]]),
    });
    expect(check(diagnoseProject(broken), "native runtime").status).toBe("fail");
    // Web does not start it, so it is demoted and cannot decide a web request's exit code.
    expect(check(diagnoseProject(broken, { target: "web" }), "native runtime").status).toBe("warn");
    // Every native target does start it, so none of them demote it.
    for (const target of ["android", "desktop", "ios"] as const) {
      expect(check(diagnoseProject(broken, { target }), "native runtime").status).toBe("fail");
    }
  });

  it("should fail a requested web build with no web entry", () => {
    const base = snapshot({});
    const report = diagnoseProject(
      { ...base, files: new Set([...base.files].filter((file) => file !== "src/main.ts")) },
      { target: "web" },
    );
    expect(check(report, "requested build").status).toBe("fail");
    expect(check(report, "requested build").detail).toContain("src/main.ts");
  });

  it("should leave the unscoped report exactly as it was", () => {
    const unsupported = snapshot({
      androidToolchain: { jdkMajor: 26, jdkVersion: "26.0.2", sdkVersion: "35.0.0" },
    });
    const report = diagnoseProject(unsupported);
    expect(report.checks.some(({ name }) => name === "requested build")).toBe(false);
    expect(check(report, "target android").status).toBe("warn");
    expect(check(report, "target android").detail).toContain("available —");
    expect(report.pass).toBe(true);
  });
});
