import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";
import { defineAudioClasses } from "../src/audio.js";
import { defineRenderPipeline } from "../src/browser-entry.js";
import { definePass } from "../src/pass-node.js";

class Vector3 {
  x = 0;
  y = 0;
  z = 0;
  set(x: number, y: number, z: number) {
    Object.assign(this, { x, y, z });
    return this;
  }
  applyQuaternion() {
    return this;
  }
}
class Object3D {
  parent: object | null = {};
  matrixWorld = { decompose: (position: Vector3) => position.set(2, 3, 4) };
  updateMatrixWorld() {}
  updateWorldMatrix() {}
  copy() {
    return this;
  }
}

it("loads packaged audio through the Perry host, retains native PCM and drains startup/ended events", async () => {
  let update!: (dt: number) => void;
  const heap = new ArrayBuffer(65536);
  const view = new DataView(heap);
  let next = 16;
  let nextNode = 10;
  let nextDecode = 100;
  let state = 0;
  const params = new Map<string, number>();
  const ended = new Set<number>();
  const errors = new Map<number, string>([[1, "TN_AUDIO_DECODE: invalid Ogg"]]);
  const decodes = new Map<number, boolean>();
  const calls: Array<[number, number, number, number[]]> = [];
  const native = {
    alloc: (size: number) => {
      const at = next;
      next += size + 8;
      new Uint8Array(heap, at, size).fill(0);
      return at;
    },
    free: vi.fn(),
    memory: (kind: number, at: number, value: number) => {
      if (kind === 20) {
        view.setFloat64(at, value, true);
        return value;
      }
      return view.getFloat64(at, true);
    },
    readString: (at: number) => errors.get(at) ?? "",
    physicsCopy: vi.fn(
      (
        value: Uint8Array | Float32Array,
        at: number,
        count: number,
        kind: number,
        toNative: boolean,
      ) => {
        const data = new Uint8Array(value.buffer, value.byteOffset, count * (kind === 1 ? 1 : 4));
        if (toNative) new Uint8Array(heap, at, data.length).set(data);
        else data.set(new Uint8Array(heap, at, data.length));
        return 0;
      },
    ),
    audioCall: (
      op: number,
      context: number,
      object: number,
      packet: number,
      data: number,
      size: number,
    ) => {
      const p = Array.from({ length: 8 }, (_, i) => view.getFloat64(packet + i * 8, true));
      calls.push([op, context, object, p.slice()]);
      const out = (...values: number[]) =>
        values.forEach((value, i) => view.setFloat64(packet + i * 8, value, true));
      if (op === 0) out(1, 44100);
      if (op === 1) out(44100, 2, state);
      if (op === 2) state = 1;
      if (op === 3) state = 0;
      if (op === 5) out(nextNode++);
      if (op === 12) out(ended.delete(object) ? 1 : 0);
      if (op === 13) {
        const key = `${object}:${p[0]}`;
        if (p[1] === 0) out(params.get(key) ?? 1);
        else params.set(key, p[2] as number);
      }
      if (op === 14) {
        expect(size).toBeGreaterThan(0);
        decodes.set(++nextDecode, new Uint8Array(heap, data, size)[0] === 79);
        out(nextDecode);
      }
      if (op === 15) {
        if (!decodes.get(object)) return 1;
        out(1, 200, 1, 4, 44100);
      }
      if (op === 17) {
        out(60000, 4);
        new Float32Array(heap, 60000, 4).set([0.1, 0.2, 0.3, 0.4]);
      }
      return 0;
    },
    playerRunner: () => 0,
    playerSpan: () => 0,
    playerBind: (tick: typeof update) => {
      update = tick;
      return 0;
    },
    playerCodes: () => "",
    playerClose: vi.fn(),
  };
  const compilerOptions = { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 };
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const nodeRequire = createRequire(import.meta.url);
  const load = (name: string): Record<string, unknown> => {
    if (name === "tn-native-transport") return native;
    if (!name.startsWith("./perry-")) return nodeRequire(name) as Record<string, unknown>;
    if (cache.has(name)) return cache.get(name)?.exports ?? {};
    const module = { exports: {} };
    cache.set(name, module);
    runInNewContext(
      transpileModule(
        readFileSync(new URL(`../src/${name.replace(/\.js$/, ".ts")}`, import.meta.url), "utf8"),
        { compilerOptions },
      ).outputText,
      {
        module,
        exports: module.exports,
        require: load,
        Uint8Array,
        Float32Array,
        ArrayBuffer,
        console,
      },
    );
    return module.exports;
  };
  const source = readFileSync(new URL("../src/perry-host.ts", import.meta.url), "utf8")
    .replace(/import\s*\{([^}]+)\}\s*from "tn-native-transport";/u, "const {$1} = native;")
    .replace(
      'import { assetPath } from "./perry-asset-path.js";',
      readFileSync(new URL("../src/perry-asset-path.ts", import.meta.url), "utf8").replace(
        "export function",
        "function",
      ),
    )
    .replace(
      'import { createPerryPhysicsHost } from "./perry-physics.js";',
      "const createPerryPhysicsHost = () => ({});",
    )
    .replace('import { __tnLoadAsset } from "three";', "const __tnLoadAsset = () => [];")
    .replace(
      'import { nativeImageBitmaps } from "./texture-sources.js";',
      "const nativeImageBitmaps = new WeakMap();",
    );
  const assets = mkdtempSync(join(tmpdir(), "perry-audio-"));
  mkdirSync(join(assets, "audio"));
  writeFileSync(join(assets, "audio", "cue.ogg"), Buffer.from([79, 103, 103]));
  const sandbox = {
    native,
    exports: {},
    require: load,
    console,
    process: { env: { TN_ASSET_ROOT: assets } },
    fetch,
    setTimeout,
    Response,
    URL,
    Uint8Array,
    ArrayBuffer,
  };
  try {
    runInNewContext(transpileModule(source, { compilerOptions }).outputText, sandbox);
    const host = sandbox as unknown as {
      AudioContext: typeof globalThis.AudioContext;
      exports: { closePlayer(): void };
      fetch(url: string): Promise<Response>;
    };
    expect(typeof host.AudioContext).toBe("function");
    let audio!: ReturnType<typeof defineAudioClasses>;
    const facade: { bindPerryEngine?: (names: string[]) => Record<string, unknown> } = {};
    const classes = { Object3D, Vector3, Quaternion: Object, Color: Object };
    const collect = vi.fn();
    const syncTsl = vi.fn();
    const modules: Record<string, unknown> = {
      "tn-native-transport": native,
      "../api/catalog.json": { entries: [] },
      "../api/native-registry.json": {},
      "./audio.js": {
        defineAudioClasses: (engine: Parameters<typeof defineAudioClasses>[0]) => {
          audio = defineAudioClasses(engine);
          return audio;
        },
      },
      "./browser-backend.js": { defineBrowserClasses: () => ({ classes, collect }) },
      "./browser-entry.js": {
        defineRenderPipeline,
        withTextureSources: () => classes,
        bindUpstreamExports: (_names: unknown, _catalog: unknown, bound: unknown) => bound,
      },
      "./browser-tsl.js": { defineTsl: () => ({ exports: {}, sync: syncTsl }) },
      "./pass-node.js": { definePass },
      "./object-surface.js": { Material: Object, defineTypeFlags() {}, defineObjectSurface() {} },
      "./perry-transport.js": { createPerryRuntime: () => ({ tsl: {}, render() {} }) },
      "./perry-renderer.js": {
        definePerryRenderer: ({ sync }: { sync(): void }) =>
          class {
            render() {
              sync();
            }
          },
      },
      "./property-binding.js": { definePropertyBinding: () => ({}) },
      "./quad-mesh.js": { defineQuadMesh: () => Object },
      "./reflector.js": { defineReflector: () => Object },
    };
    runInNewContext(
      transpileModule(readFileSync(new URL("../src/perry-entry.ts", import.meta.url), "utf8"), {
        compilerOptions,
      }).outputText,
      { exports: facade, require: (name: string) => modules[name], fetch: host.fetch },
    );
    const bound = facade.bindPerryEngine?.([
      "AudioContext",
      "AudioLoader",
      "AudioListener",
      "Audio",
      "PositionalAudio",
    ]);
    expect(bound?.AudioLoader).toBe(audio.AudioLoader);
    const Renderer = bound?.WebGPURenderer as new () => { render(): void };
    const renderer = new Renderer();
    const context = new host.AudioContext();
    audio.AudioContext.setContext(context);
    let settled = false;
    const loading = new audio.AudioLoader().loadAsync("audio/cue.ogg").then((buffer) => {
      settled = true;
      return buffer;
    });
    await vi.waitFor(() => expect(decodes.size).toBe(1));
    expect(settled).toBe(false);
    update(1 / 60);
    const buffer = await loading;
    expect(buffer).toMatchObject({ length: 4, numberOfChannels: 1, sampleRate: 44100 });
    expect(buffer.duration).toBe(4 / 44100);
    expect(native.physicsCopy).toHaveBeenCalledTimes(1);
    expect(native.physicsCopy.mock.calls[0]?.[4]).toBe(true);
    expect(buffer.getChannelData(0)[1]).toBeCloseTo(0.2);
    expect(native.physicsCopy).toHaveBeenCalledTimes(2);
    expect(native.physicsCopy.mock.calls[1]?.slice(2)).toEqual([4, 6, false]);
    const listener = new audio.AudioListener();
    const voice = new audio.PositionalAudio(listener);
    voice.setBuffer(buffer).setVolume(0.25);
    await context.resume();
    expect(context.state).toBe("running");
    voice.play();
    renderer.render();
    expect(collect).toHaveBeenCalledOnce();
    expect(syncTsl).toHaveBeenCalledOnce();
    expect(calls.some(([op, , , p]) => op === 19 && p.slice(0, 4).join() === "0,2,3,4")).toBe(true);
    expect(calls.some(([op, , , p]) => op === 18 && p.slice(0, 4).join() === "4,2,3,4")).toBe(true);
    expect(calls.some(([op]) => op === 8)).toBe(true);
    expect(voice.isPlaying).toBe(true);
    const bufferSource = voice.source as AudioBufferSourceNode & { handle: number };
    ended.add(bufferSource.handle);
    update(1 / 60);
    expect(voice.isPlaying).toBe(false);
    const failed = context.decodeAudioData(Buffer.from([0]) as unknown as ArrayBuffer);
    const rejection = expect(failed).rejects.toThrow("TN_AUDIO_DECODE: invalid Ogg");
    update(1 / 60);
    await rejection;
    expect(() => context.createOscillator()).toThrow(
      "TN_AUDIO_UNSUPPORTED: AudioContext.createOscillator",
    );
    bufferSource.playbackRate.setValueAtTime(0.5, 0);
    expect(calls.at(-1)?.[3].slice(0, 4)).toEqual([8, 2, 0.5, 0]);
    bufferSource.playbackRate.setTargetAtTime(1.25, 1, 0.2);
    expect(calls.at(-1)?.[3].slice(0, 5)).toEqual([8, 4, 1.25, 1, 0.2]);
    expect(() => {
      bufferSource.playbackRate.value = -1;
    }).toThrow("TN_AUDIO_ARGUMENT");
    expect(() => {
      voice.panner.coneInnerAngle = 90;
    }).toThrow("TN_AUDIO_UNSUPPORTED: PannerNode.coneInnerAngle");
    const hanging = context.decodeAudioData(Buffer.from([79]) as unknown as ArrayBuffer);
    const closed = expect(hanging).rejects.toThrow(
      "TN_AUDIO_STATE: AudioContext.close during decodeAudioData",
    );
    host.exports.closePlayer();
    await closed;
    expect(context.state).toBe("closed");
    expect(native.playerClose).toHaveBeenCalledOnce();
    expect(calls.some(([op]) => op === 4)).toBe(true);
    expect(native.free).toHaveBeenCalled();
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});
