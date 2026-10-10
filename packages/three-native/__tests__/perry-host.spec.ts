import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";

it("drives core frames, input, timers and async mailbox observations through player callbacks", async () => {
  let update!: (dt: number) => void;
  let frame!: (ms: number) => void;
  let observe!: (method: number, argument: number) => number;
  let codes = "";
  let nextPointer = 3;
  const strings = new Map<number, string>([
    [1, "sample"],
    [2, ""],
  ]);
  const native = {
    playerBind: (tick: typeof update, draw: typeof frame, read: typeof observe) => {
      update = tick;
      frame = draw;
      observe = read;
      return 0;
    },
    playerCapture: () => 0,
    playerClose: vi.fn(),
    playerOpen: () => 0,
    playerRunner: () => 1,
    playerStep: () => 0,
    playerCodes: () => codes,
    readString: (at: number) => strings.get(at),
    stringBytes: (value: string) => Buffer.byteLength(value),
    alloc: () => nextPointer++,
    free: vi.fn(),
    writeString: (value: string, at: number) => {
      strings.set(at, value);
      return 0;
    },
  };
  const source = readFileSync(new URL("../src/perry-host.ts", import.meta.url), "utf8")
    .replace(/import\s*\{([^}]+)\}\s*from "tn-native-transport";/u, "const {$1} = native;")
    .replace(
      'import { createPerryPhysicsHost } from "./perry-physics.js";',
      'const createPerryPhysicsHost = () => ({ version: "0.30.0", createSimulation() {} });',
    )
    .replace('import { __tnLoadAsset } from "three";', "const __tnLoadAsset = () => [];")
    .replace(
      'import { nativeImageBitmaps } from "./texture-sources.js";',
      "const nativeImageBitmaps = new WeakMap();",
    );
  const assets = mkdtempSync(join(tmpdir(), "perry-host-"));
  mkdirSync(join(assets, "models"));
  writeFileSync(join(assets, "models", "a b.json"), "{}");
  const hostFetch = vi.fn(async () => new Response("net"));
  const sandbox = {
    native,
    exports: {},
    console,
    require: createRequire(import.meta.url),
    process: { env: { TN_ASSET_ROOT: `${assets}/` } },
    fetch: hostFetch,
    Response,
    URL,
    setTimeout,
  } as unknown as {
    fetch(url: string): Promise<Response>;
    exports: {
      nextHostTurn(): Promise<void>;
      platform: {
        inputTarget: { addEventListener(type: string, callback: (event: unknown) => void): void };
      };
      openPlayer(): void;
      stepPlayer(): boolean;
      closePlayer(): void;
    };
    __THREENATIVE_NATIVE__: { platform: { runtime: string }; physics: { version: string } };
    __THREENATIVE_PLAYTEST_BRIDGE__?: Record<string, (...args: unknown[]) => unknown>;
    requestAnimationFrame(callback: (time: number) => void): number;
    setTimeout(callback: () => void, delay: number): number;
  };
  runInNewContext(
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
  expect(sandbox.__THREENATIVE_NATIVE__.platform.runtime).toBe("native");
  expect(sandbox.__THREENATIVE_NATIVE__.physics.version).toBe("0.30.0");
  const canvas = sandbox.exports.platform.inputTarget;
  const keyDown = vi.fn();
  const keyUp = vi.fn();
  canvas.addEventListener("keydown", keyDown);
  canvas.addEventListener("keyup", keyUp);
  codes = "KeyW";
  update(1 / 60);
  expect(keyDown).toHaveBeenCalledWith({ code: "KeyW", key: "w" });
  codes = "";
  update(1 / 60);
  expect(keyUp).toHaveBeenCalledWith({ code: "KeyW", key: "w" });
  const draw = vi.fn();
  sandbox.requestAnimationFrame(draw);
  frame(48);
  frame(64);
  expect(draw).toHaveBeenCalledExactlyOnceWith(48);
  const timer = vi.fn();
  sandbox.setTimeout(timer, 10);
  update(1 / 60);
  update(1 / 60);
  expect(timer).toHaveBeenCalledTimes(1);
  expect(JSON.parse(strings.get(observe(1, 2)) as string)).toEqual({ fallback: true });
  const sample = vi.fn(async (request) => ({ tick: request.include === undefined ? 4 : 0 }));
  sandbox.__THREENATIVE_PLAYTEST_BRIDGE__ = { sample };
  expect(observe(1, 2)).toBe(0);
  await Promise.resolve();
  const answer = observe(1, 2);
  expect(JSON.parse(strings.get(answer) as string)).toEqual({ result: { tick: 4 } });
  expect(sample).toHaveBeenCalledTimes(1);
  expect(sample).toHaveBeenCalledWith({});
  strings.set(1, "drainEvents");
  expect(JSON.parse(strings.get(observe(1, 2)) as string).error).toContain(
    "missing method drainEvents",
  );
  const drain = vi.fn(() => []);
  sandbox.__THREENATIVE_PLAYTEST_BRIDGE__ = { drainEvents: drain };
  observe(1, 2);
  expect(drain).toHaveBeenCalledExactlyOnceWith();
  strings.set(1, "missing");
  expect(JSON.parse(strings.get(observe(1, 2)) as string).error).toContain(
    "TN_INSPECT_GAME_BRIDGE",
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  sandbox.__THREENATIVE_PLAYTEST_BRIDGE__ = { missing: async () => cyclic };
  expect(observe(1, 2)).toBe(0);
  await Promise.resolve();
  expect(JSON.parse(strings.get(observe(1, 2)) as string).error).toContain(
    "TN_INSPECT_GAME_BRIDGE",
  );
  sandbox.exports.openPlayer();
  expect(sandbox.exports.stepPlayer()).toBe(false);
  sandbox.exports.closePlayer();
  expect(native.playerClose).toHaveBeenCalledTimes(1);
  // The game clock replaced setTimeout; the host turn still runs on the platform timer.
  await sandbox.exports.nextHostTurn();
  expect(await (await sandbox.fetch("/models/a%20b.json?v=1")).text()).toBe("{}");
  expect(await (await sandbox.fetch("./models/a b.json")).text()).toBe("{}");
  expect((await sandbox.fetch("models/missing.json")).status).toBe(404);
  await expect(sandbox.fetch("../secret")).rejects.toThrow("TN_PERRY_ASSET_PATH");
  expect(await (await sandbox.fetch("https://example.test/x")).text()).toBe("net");
  expect(hostFetch).toHaveBeenCalledTimes(1);
});
