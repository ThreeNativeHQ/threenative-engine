import type { SpawnSyncReturns } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { build } from "../src/build.js";

const { calls, compiled } = vi.hoisted(() => ({
  calls: [] as string[],
  compiled: [] as Record<string, unknown>[],
}));

vi.mock("@threenative/assets", () => ({
  compileAssets: async (options: Record<string, unknown>) => {
    compiled.push(options);
    calls.push("compile");
    return { skipped: 0, written: 0 };
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const spawn = ((command: string, args: readonly string[]) => {
    const script = path.basename(args[0] ?? command);
    calls.push(`spawn:${script}`);
    const child = new EventEmitter();
    queueMicrotask(async () => {
      if (script === "bundle.mjs") {
        child.emit("exit", 23);
        return;
      }
      // A real Vite build creates the outDir it was pointed at, and the web build refuses to
      // publish one that is still missing — so the stub has to be as complete as what it replaces.
      const index = args.indexOf("--outDir");
      const out = args[index + 1];
      if (index >= 0 && out !== undefined) await mkdir(path.resolve(out), { recursive: true });
      child.emit("exit", 0);
    });
    return child;
  }) as typeof actual.spawn;
  const spawnSync = (): SpawnSyncReturns<string> => ({
    pid: 0,
    output: [null, "fixture + v8 build", ""],
    signal: null,
    status: 0,
    stderr: "",
    stdout: "fixture + v8 build",
  });
  return { ...actual, spawn, spawnSync };
});

afterEach(() => {
  calls.splice(0);
  compiled.splice(0);
});

async function writeProject(root: string, engine = "threejs"): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "asset-order" }));
  await writeFile(path.join(root, "src/game.ts"), "export default { start: async () => {} };\n");
  await writeFile(
    path.join(root, "threenative.config.ts"),
    `export default { engine: "${engine}" };\n`,
  );
}

async function writeRuntime(root: string, available = true): Promise<void> {
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  const binary = path.join(runtime, "fixture-runtime");
  await writeFile(binary, "fixture runtime identity");
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({ name: "@threenative/runtime-native", type: "module" }),
  );
  await writeFile(
    path.join(runtime, "scripts/package-desktop.mjs"),
    `export async function resolveDesktopRuntime() { ${available ? `return ${JSON.stringify(binary)};` : 'throw new Error("TN_TEST_RUNTIME_UNAVAILABLE");'} }\n`,
  );
}

describe("threenative build asset compilation", () => {
  it("should compile assets before invoking vite", async () => {
    const root = await makeTempDir("threenative-build-assets-web-");
    await writeProject(root);

    await build({ cwd: root, target: "web" });

    const compileIndex = calls.indexOf("compile");
    const spawnIndex = calls.findIndex((call) => call.startsWith("spawn:"));
    expect(compileIndex).toBeGreaterThanOrEqual(0);
    expect(spawnIndex).toBeGreaterThan(compileIndex);
  });

  it("should cook decoder-free models and textures for the web native engine", async () => {
    const root = await makeTempDir("threenative-build-assets-web-native-");
    await writeProject(root, "threenative");

    await build({ cwd: root, target: "web" });

    // The Wasm engine's glTF loader refuses Meshopt and KTX2, so the web cook must not emit them.
    expect(compiled[0]?.runtimeDecoders).toEqual({ ktx2: false, meshopt: false });
    expect(compiled[0]?.runtimeIdentity).toBe("web:native-engine");
  });

  it("should keep the decoders for the legacy web engine", async () => {
    const root = await makeTempDir("threenative-build-assets-web-legacy-");
    await writeProject(root);

    await build({ cwd: root, target: "web" });

    expect(compiled[0]?.runtimeDecoders).toBeUndefined();
  });

  it("should reject an unavailable desktop runtime before cooking assets", async () => {
    const root = await makeTempDir("threenative-build-assets-unavailable-runtime-");
    await writeProject(root);
    await writeRuntime(root, false);

    await expect(build({ cwd: root, target: "desktop" })).rejects.toThrow(
      "TN_TEST_RUNTIME_UNAVAILABLE",
    );
    expect(calls).toEqual([]);
  });

  it("should compile assets before native packaging", async () => {
    const root = await makeTempDir("threenative-build-assets-native-");
    await writeProject(root);

    await writeRuntime(root);

    // Runtime preflight succeeds; the controlled bundler failure must happen after cooking,
    // before packaging, rather than an unrelated missing-runtime error satisfying the test.
    await expect(build({ cwd: root, target: "desktop" })).rejects.toThrow(
      `${path.basename(process.execPath)} exited with code 23.`,
    );
    expect(calls).toEqual(["compile", "spawn:bundle.mjs"]);
  });
});
