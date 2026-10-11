/**
 * Incremental strict builds (PRD-530, Solution item 3): the compiler and the engine are prebuilt
 * inputs, so a game-source-only edit re-stages and re-runs Perry (which recompiles only the changed
 * module and relinks), and nothing else runs: no engine or Dawn build, no compiler build, not even
 * the shim or the hooks. The first part drives buildStrict with recording tools; the second builds a
 * real game with the pinned Perry against this checkout's engine archives when both are on disk.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
// @ts-expect-error -- plain ESM with no type declarations.
import { provision } from "../../../tools/native-typescript/provision.mjs";
import {
  ENGINE_LIBS,
  buildStrict,
  stagePlayerUiLink,
  stageWorkspaceSources,
  summarizeCompilerOutput,
  workspaceSources,
  // @ts-expect-error -- plain ESM with no type declarations.
} from "../scripts/package-strict.mjs";

interface IBuild {
  exe: string;
  ran: string[];
  errors: string[];
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(prefix: string): string {
  const root = makeTempDirSync(prefix);
  roots.push(root);
  return root;
}

const COMPILER = "/opt/perry/perry";

/**
 * Records every tool call and writes each output as a digest of the call and the source it reads,
 * so an unchanged source gives the same object and a changed one a different object.
 */
function recordingExec(calls: string[][], fail?: (tool: string, args: string[]) => boolean) {
  return (tool: string, args: string[]) => {
    calls.push([tool, ...args]);
    if (fail?.(tool, args)) return `${tool}: error: refused`;
    const outFlag = args.find((arg) => arg.startsWith("-o="));
    const flag = args.includes("-o") ? "-o" : "--write";
    const output = outFlag
      ? outFlag.slice(3)
      : args.includes(flag)
        ? args[args.indexOf(flag) + 1]
        : tool === "ar"
          ? args[1]
          : undefined;
    if (output === undefined || !output.startsWith("/"))
      throw new Error(`no absolute output in ${args.join(" ")}`);
    const source = args.find((arg) => /\.(ts|c|cpp)$/u.test(arg));
    const hash = createHash("sha256").update(args.join(" "));
    if (source) hash.update(readFileSync(source));
    writeFileSync(output as string, hash.digest("hex"));
    return undefined;
  };
}

function setup() {
  const root = tempRoot("tn-strict-incremental-");
  const engineBuild = join(root, "engine");
  mkdirSync(engineBuild, { recursive: true });
  for (const lib of ENGINE_LIBS as string[]) writeFileSync(join(engineBuild, `lib${lib}.a`), lib);
  writeFileSync(join(engineBuild, "tn-native-engine-identity"), "identity tool");
  const entry = join(root, "game.ts");
  writeFileSync(entry, 'import { Scene } from "three";\nconsole.log(new Scene().type);\n');
  const calls: string[][] = [];
  const build = (exec = recordingExec(calls)): IBuild =>
    buildStrict({
      name: "game",
      entry,
      outDir: join(root, "out"),
      engineBuild,
      compiler: { binaryPath: COMPILER, identity: "perry test" },
      exec,
    });
  return { root, engineBuild, entry, calls, build };
}

const toolsOf = (calls: string[][]) => calls.map(([tool]) => tool);

describe("strict workspace sources", () => {
  it("stages core subpaths and their workspace dependencies using declared native exports", () => {
    const root = tempRoot("tn-strict-workspace-");
    const entry = join(root, "game.ts");
    writeFileSync(
      entry,
      'import { defineGame } from "@threenative/core";\nimport { playtest } from "@threenative/core/playtest";\nimport { hot } from "@threenative/core/hot";\nimport { rapier } from "@threenative/physics";\n',
    );
    const packages = workspaceSources(entry);
    const byName = new Map<string, { manifest: { name: string }; exports: Map<string, string> }>(
      packages.map(
        (pkg: { manifest: { name: string }; exports: Map<string, string> }) =>
          [pkg.manifest.name, pkg] as const,
      ),
    );
    expect(byName.has("@threenative/playtest")).toBe(true);
    expect(byName.get("@threenative/physics")?.exports.get(".")).toBe("src/native/index.ts");
    stageWorkspaceSources(root, packages);
    const core = join(root, "node_modules/@threenative/core");
    const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.exports["./playtest"]).toBe("./src/playtest.ts");
    expect(manifest.exports["./hot"]).toBe("./src/hot.ts");
    expect(readFileSync(join(core, "playtest.ts"), "utf8")).toContain('"./src/playtest.js"');
    expect(existsSync(join(core, "src/game.ts"))).toBe(true);
    expect(existsSync(join(core, "dist"))).toBe(false);
    expect(
      readFileSync(join(root, "node_modules/@threenative/physics/index.ts"), "utf8"),
    ).toContain('"./src/native/index.js"');
    expect(
      readFileSync(join(root, "node_modules/@threenative/physics/src/index.ts"), "utf8"),
    ).toContain('"./native/index.js"');
  });

  it("refuses an undeclared workspace subpath instead of silently resolving source internals", () => {
    const root = tempRoot("tn-strict-workspace-");
    const entry = join(root, "game.ts");
    writeFileSync(entry, 'import { hidden } from "@threenative/core/hidden";\n');
    expect(() => workspaceSources(entry)).toThrow(/TN_STRICT_WORKSPACE_EXPORT/u);
  });
});

it.runIf(process.platform === "linux")(
  "stages WebKit linker dependencies only for an engine with the web UI backend",
  () => {
    const dir = makeTempDirSync("tn-player-ui-link-");
    const file = join(dir, "package.json");
    const cache = join(dir, "CMakeCache.txt");
    const manifest = {
      perry: { nativeLibrary: { targets: { linux: { libs: ["tn_engine_player"] } } } },
    };
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(cache, "TN_ENABLE_UI_OVERLAY:BOOL=OFF\nTN_ENABLE_CSS_UI:BOOL=ON\n");
    stagePlayerUiLink(dir, dir);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(manifest);
    writeFileSync(cache, "TN_ENABLE_UI_OVERLAY:BOOL=ON\n");
    stagePlayerUiLink(dir, dir);
    expect(JSON.parse(readFileSync(file, "utf8")).perry.nativeLibrary.targets.linux).toEqual({
      libs: ["tn_engine_player"],
      pkgConfig: ["webkit2gtk-4.1"],
    });
  },
);

describe("strict builds are incremental", () => {
  it("builds every step once, then nothing while nothing changed", () => {
    const { calls, build } = setup();
    const first = build();
    expect(first.errors).toEqual([]);
    expect(first.ran).toEqual(["typescript", "shim", "hooks", "link", "identity"]);
    expect(existsSync(first.exe)).toBe(true);
    expect(existsSync(`${first.exe}.identity`)).toBe(true);
    calls.length = 0;
    const second = build();
    expect(second).toMatchObject({ errors: [], ran: [] });
    expect(calls).toEqual([]);
  });

  it("recompiles only the TypeScript and relinks after a game-source-only edit", () => {
    const { entry, calls, build } = setup();
    build();
    calls.length = 0;
    writeFileSync(entry, 'import { Scene } from "three";\nconsole.log(new Scene().name);\n');
    const rebuilt = build();
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.ran).toEqual(["typescript", "link"]);
    // One Perry invocation compiles the graph and links it; no cc, no hooks, no engine build.
    expect(toolsOf(calls)).toEqual(["ar", COMPILER]);
    expect(calls.at(-1)).toContain("-o");
    expect(calls.flat().some((arg) => /cmake|ninja|download-deps/u.test(arg))).toBe(false);
  });

  it("rebuilds the hooks and relinks when the engine archives change, not the TypeScript", () => {
    const { engineBuild, calls, build } = setup();
    build();
    calls.length = 0;
    writeFileSync(join(engineBuild, "libtn_engine_scene.a"), "a newer engine");
    expect(build().ran).toEqual(["hooks", "link"]);
  });

  it("refuses a missing engine archive without building anything", () => {
    const { engineBuild, calls, build } = setup();
    rmSync(join(engineBuild, "libtn_engine_abi.a"));
    const result = build();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^TN_STRICT_ENGINE_MISSING: .*libtn_engine_abi\.a/u);
    expect(calls).toEqual([]);
  });

  it("records nothing for a failed step, so the next build retries it", () => {
    const { calls, build } = setup();
    const failed = build(recordingExec(calls, (tool) => tool === COMPILER));
    expect(failed.errors[0]).toMatch(/error: refused/u);
    expect(failed.ran).toEqual(["typescript", "shim", "hooks", "link"]);
    expect(build().ran).toEqual(["link", "identity"]);
  });
});

describe("a game's source tree is staged with its layout", () => {
  function tree(extra: { stageOnly?: boolean } = {}) {
    const { root, engineBuild, calls } = setup();
    const project = join(root, "project");
    mkdirSync(join(project, "src", "scenes"), { recursive: true });
    mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
    writeFileSync(
      join(project, "src", "game.ts"),
      'import { Play } from "./scenes/Play.js";\nconsole.log(Play);\n',
    );
    writeFileSync(join(project, "src", "scenes", "Play.ts"), "export const Play = 1;\n");
    writeFileSync(join(project, "threenative.config.ts"), "export default {};\n");
    writeFileSync(join(project, "node_modules", "dep", "index.ts"), "export {};\n");
    const build = () =>
      buildStrict({
        name: "game",
        entry: join(project, "src", "game.ts"),
        sourceRoot: project,
        ...extra,
        outDir: join(root, "out"),
        engineBuild,
        compiler: { binaryPath: COMPILER, identity: "perry test" },
        exec: recordingExec(calls),
      });
    return { project, out: join(root, "out"), build, calls };
  }

  it("keeps folders, copies the config beside them and leaves node_modules out", () => {
    const { out, build } = tree();
    expect(build().errors).toEqual([]);
    expect(existsSync(join(out, "src", "game.ts"))).toBe(true);
    expect(existsSync(join(out, "src", "scenes", "Play.ts"))).toBe(true);
    expect(existsSync(join(out, "threenative.config.ts"))).toBe(true);
    expect(existsSync(join(out, "node_modules", "dep"))).toBe(false);
  });

  it("recompiles after an edit to a module that is not the entry", () => {
    const { project, build, calls } = tree();
    build();
    calls.length = 0;
    writeFileSync(join(project, "src", "scenes", "Play.ts"), "export const Play = 2;\n");
    expect(build().ran).toEqual(["typescript", "link"]);
    expect(toolsOf(calls)).toEqual(["ar", COMPILER]);
  });

  it("stops after staging when asked, before Perry runs", () => {
    const { out, build, calls } = tree({ stageOnly: true });
    const staged = build();
    expect(staged.errors).toEqual([]);
    expect(staged.ran).toEqual(["typescript", "shim", "hooks"]);
    expect(toolsOf(calls)).not.toContain(COMPILER);
    expect(existsSync(join(out, "src", "scenes", "Play.ts"))).toBe(true);
  });

  it("drops a staged file the game deleted", () => {
    const { project, out, build } = tree();
    build();
    writeFileSync(join(project, "src", "scenes", "Extra.ts"), "export {};\n");
    build();
    expect(existsSync(join(out, "src", "scenes", "Extra.ts"))).toBe(true);
    rmSync(join(project, "src", "scenes", "Extra.ts"));
    build();
    expect(existsSync(join(out, "src", "scenes", "Extra.ts"))).toBe(false);
  });
});

describe("a compiler failure names what caused it", () => {
  const perryOutput = [
    "  Warning: Could not resolve import '@threenative/core' from game.ts",
    "  Warning: Could not resolve import '@threenative/core' from Play.ts",
    "  Warning: Could not resolve import 'three/tsl' from fog.ts",
    "/usr/bin/ld: perry_module:(.text+0x1978): undefined reference to `defineGame'",
    "Error: Linking failed",
  ].join("\n");

  it("leads with the unresolved imports, once each, ahead of the link line", () => {
    expect(summarizeCompilerOutput(perryOutput, 1, "perry")).toBe(
      "TN_STRICT_UNRESOLVED_IMPORT: 2 import(s) did not resolve: @threenative/core, three/tsl (/usr/bin/ld: perry_module:(.text+0x1978): undefined reference to `defineGame')",
    );
  });

  it("keeps Perry's own error when nothing was unresolved", () => {
    expect(summarizeCompilerOutput("Error: Failed to parse game.ts: Parse error", 1, "perry")).toBe(
      "Error: Failed to parse game.ts: Parse error",
    );
    expect(summarizeCompilerOutput("something odd\n", 3, "cc")).toBe("cc exited 3: something odd");
  });

  it("keeps Perry's namespace-import error, which already names its module", () => {
    const output = `  Warning: Could not resolve import 'three/webgpu' from vfx.ts\nError: Could not resolve namespace import \`import * as ... from "three/webgpu"\` in vfx.ts`;
    expect(summarizeCompilerOutput(output, 1, "perry")).toMatch(
      /^Error: Could not resolve namespace import/u,
    );
  });

  it("says nothing for a clean run, whatever it warned about", () => {
    expect(
      summarizeCompilerOutput("  Warning: Could not resolve import 'x' from a.ts\n", 0, "perry"),
    ).toBeUndefined();
  });
});

const REPO = join(import.meta.dirname, "..", "..", "..");
const ENGINE_BUILD = join(REPO, "packages", "runtime-native", "build", "tn-linux");
const FIXTURE = join(REPO, "tools", "native-typescript", "corpus", "three-fixture.ts");
const compiler = await provision({ checkOnly: true, log: () => {} }).catch(() => undefined);
const realLane =
  compiler !== undefined &&
  (ENGINE_LIBS as string[]).every((lib) => existsSync(join(ENGINE_BUILD, `lib${lib}.a`))) &&
  existsSync(join(ENGINE_BUILD, "tn-native-engine-identity"));

describe.runIf(realLane)("a real strict build with the pinned Perry", () => {
  it("relinks a game edit without touching the engine, and the artifact runs and checks", () => {
    const root = tempRoot("tn-strict-real-");
    const entry = join(root, "game.ts");
    writeFileSync(entry, readFileSync(FIXTURE));
    const build = (): IBuild =>
      buildStrict({
        name: "game",
        entry,
        outDir: join(root, "out"),
        engineBuild: ENGINE_BUILD,
        compiler: {
          binaryPath: compiler.binaryPath,
          identity: `perry ${compiler.lock.tag} ${compiler.artifact.sha256}`,
        },
      });
    const first = build();
    expect(first.errors).toEqual([]);
    expect(first.ran).toEqual(["typescript", "shim", "hooks", "link", "identity"]);
    writeFileSync(entry, `${readFileSync(FIXTURE, "utf8")}console.log("edited");\n`);
    const second = build();
    expect(second.errors).toEqual([]);
    expect(second.ran).toEqual(["typescript", "link"]);
    const run = spawnSync(second.exe, { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `${readFileSync(FIXTURE.replace(/\.ts$/u, ".expected"), "utf8")}edited\n`,
    );
    const check = spawnSync(
      join(ENGINE_BUILD, "tn-native-engine-identity"),
      ["--check", `${second.exe}.identity`],
      {
        encoding: "utf8",
      },
    );
    expect(check.stdout.trim()).toBe("TN_ARTIFACT_IDENTITY_OK");
  }, 300_000);
});
