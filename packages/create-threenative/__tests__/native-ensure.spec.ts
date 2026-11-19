import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { build, ensureEngineDesktopPlayer } from "../src/build.js";

// PRD-783. `pnpm install` must download nothing, a web build must request no binary at all, and
// the first default-engine desktop build is the one place the player arrives — before the UI
// build, so a failed download costs no UI work.

vi.mock("@threenative/assets", () => ({
  compileAssets: async () => ({ skipped: 0, written: 0 }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const spawn = ((_command: string, args: readonly string[]) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      const index = args.indexOf("--outDir");
      const out = args[index + 1];
      if (index >= 0 && out !== undefined) await mkdir(path.resolve(out), { recursive: true });
      child.emit("exit", 0);
    });
    return child;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const roots: string[] = [];
afterEach(async () => {
  Reflect.deleteProperty(process.env, "THREENATIVE_ENGINE_PLAYER");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const PLAYER = `tn-native-engine-player-v8${process.platform === "win32" ? ".exe" : ""}`;

/**
 * A project with an installed runtime whose ensure function records every call and fails.
 *
 * A stub that *throws* is the strongest available proof: a web build that reached it cannot pass,
 * and a desktop build that reaches it still tells the test that it arrived exactly once.
 */
async function writeProject(root: string, engine?: string): Promise<string> {
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  const calls = path.join(root, "ensure-calls.txt");
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({ name: "@threenative/runtime-native", type: "module", version: "0.0.0" }),
  );
  await writeFile(
    path.join(runtime, "scripts/install-prebuilt.mjs"),
    `import { appendFileSync } from "node:fs";
export async function ensureNativeBinary() {
  appendFileSync(${JSON.stringify(calls)}, "called\\n");
  throw new Error("TN_TEST_ENSURE_CALLED");
}
`,
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "ensure-game" }));
  await writeFile(path.join(root, "src/game.ts"), "export default { start: async () => {} };\n");
  await writeFile(
    path.join(root, "threenative.config.ts"),
    engine === undefined ? "export default {};\n" : `export default { engine: "${engine}" };\n`,
  );
  return calls;
}

async function calls(calls: string): Promise<number> {
  try {
    return (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("native binaries download on first native use", () => {
  it("ships no install script, so an install downloads nothing", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve("packages/runtime-native/package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.install).toBeUndefined();
    // The manual command stays: it is the explicit "fetch now" path for an offline image.
    await expect(
      readFile(path.resolve("packages/runtime-native/scripts/install-prebuilt.mjs"), "utf8"),
    ).resolves.toContain("export async function ensureNativeBinary");
  });

  it("web build requests no binary and writes nothing under prebuilt/", async () => {
    const root = await makeTempDir("threenative-native-ensure-web-");
    roots.push(root);
    const ensureCalls = await writeProject(root);
    const requests: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      requests.push(String(url));
      throw new Error("TN_TEST_FETCH_CALLED");
    });
    try {
      await build({ cwd: root, target: "web" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(requests).toEqual([]);
    expect(await calls(ensureCalls)).toBe(0);
    expect(await exists(path.join(root, "node_modules/@threenative/runtime-native/prebuilt"))).toBe(
      false,
    );
  });

  it("default-engine desktop build ensures the player once, before the UI build", async () => {
    const root = await makeTempDir("threenative-native-ensure-desktop-");
    roots.push(root);
    const ensureCalls = await writeProject(root);
    // The bundler and packager ship beside the runtime; without them the build stops before the
    // ensure call, which is a different test.
    for (const name of ["bundle-native-engine.mjs", "package-engine-desktop.mjs"])
      await writeFile(
        path.join(root, "node_modules/@threenative/runtime-native/scripts", name),
        "export default {};\n",
      );

    await expect(build({ cwd: root, target: "desktop" })).rejects.toThrow(/TN_TEST_ENSURE_CALLED/u);
    expect(await calls(ensureCalls)).toBe(1);
    // The UI build writes here. Its absence is what makes "before the UI build" an observation
    // rather than a reading of the source order.
    expect(await exists(path.join(root, ".threenative/build/ui"))).toBe(false);
  });

  it("an explicit player or a checkout build makes zero ensure calls", async () => {
    const root = await makeTempDir("threenative-native-ensure-skip-");
    roots.push(root);
    const ensureCalls = await writeProject(root);
    const runtime = path.join(root, "node_modules/@threenative/runtime-native");

    const explicit = { THREENATIVE_ENGINE_PLAYER: "bin/player" };
    await ensureEngineDesktopPlayer(runtime, explicit);
    expect(explicit.THREENATIVE_ENGINE_PLAYER).toBe("bin/player");
    expect(await calls(ensureCalls)).toBe(0);

    await mkdir(path.join(runtime, "build/tn-engine-ui"), { recursive: true });
    await writeFile(path.join(runtime, "build/tn-engine-ui", PLAYER), "checkout player");
    const checkout = {};
    await ensureEngineDesktopPlayer(runtime, checkout);
    expect(checkout).toEqual({});
    expect(await calls(ensureCalls)).toBe(0);
  });

  it("a cold default-engine build hands the download's player to the packager", async () => {
    const root = await makeTempDir("threenative-native-ensure-player-");
    roots.push(root);
    const runtime = path.join(root, "node_modules/@threenative/runtime-native");
    await mkdir(path.join(runtime, "scripts"), { recursive: true });
    const player = path.join(runtime, "prebuilt", `${process.platform}-${process.arch}`, PLAYER);
    await writeFile(
      path.join(runtime, "scripts/install-prebuilt.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export async function ensureNativeBinary(options) {
  if (options.enginePlayer !== true) throw new Error("TN_TEST_WRONG_ASSET");
  mkdirSync(dirname(${JSON.stringify(player)}), { recursive: true });
  writeFileSync(${JSON.stringify(player)}, "downloaded player");
  return ${JSON.stringify(player)};
}
`,
    );
    const env: NodeJS.ProcessEnv = {};
    await ensureEngineDesktopPlayer(runtime, env);
    expect(env.THREENATIVE_ENGINE_PLAYER).toBe(player);
  });
});
