/**
 * The Wasm engine's WebGPURenderer over a recording host module (Midway cockpit): `antialias` and
 * `samples` reach the engine. The renderer ignored both, the surface stayed single-sampled, and
 * thin geometry (a canopy rivet bow, a trailing edge) stair-stepped where the three.js build was 4x MSAA.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { type WebEngineModule, defineWebRenderer } from "../src/browser-renderer.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

function host() {
  const types = new Map<string, number>();
  const runtime: IBrowserRuntime = {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: (name) => ({ key: `${String(types.get(name) ?? 1)}:0:1:1`, type: 1 }),
    invoke: () => null,
    get: () => undefined,
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
  };
  const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
  const state = vi.fn((..._args: number[]) => 0);
  let next = 16;
  const module = {
    HEAPU8: new Uint8Array(256),
    specialHTMLTargets: {},
    lengthBytesUTF8: (text: string) => text.length,
    stringToUTF8: () => undefined,
    UTF8ToString: () => "",
    _malloc: () => {
      next += 64;
      return next;
    },
    _free: () => undefined,
    _tnw_web_init: () => 0,
    _tnw_web_poll: () => 1,
    _tnw_web_adapter: () => 0,
    _tnw_web_error: () => 0,
    _tnw_web_resize: () => 0,
    _tnw_web_render: () => 0,
    _tnw_web_frame: () => 0,
    _tnw_web_renderer_state: state,
  } as unknown as WebEngineModule;
  const Renderer = defineWebRenderer(module, classes.Color as never);
  const canvas = { width: 300, height: 150, style: {}, setAttribute: () => undefined };
  const scene = new (classes.Scene as new () => object)();
  const camera = new (classes.PerspectiveCamera as new () => object)();
  return { Renderer, canvas, scene, camera, state };
}

async function drawn(parameters: Record<string, unknown>) {
  const { Renderer, canvas, scene, camera, state } = host();
  const renderer = new Renderer({ canvas, ...parameters }) as {
    samples: number;
    init(): Promise<unknown>;
    render(scene: unknown, camera: unknown): void;
  };
  await renderer.init();
  renderer.render(scene, camera);
  return { samples: renderer.samples, handed: state.mock.calls.at(-1)?.[5] };
}

describe("the Wasm engine's WebGPURenderer sample count", () => {
  it("is 4x MSAA for antialias, as three's WebGPURenderer, and the engine is told", async () => {
    expect(await drawn({ antialias: true })).toEqual({ samples: 4, handed: 4 });
  });

  it("is single-sampled without antialias, and an explicit samples wins", async () => {
    expect(await drawn({})).toEqual({ samples: 1, handed: 1 });
    expect(await drawn({ antialias: true, samples: 1 })).toEqual({ samples: 1, handed: 1 });
  });
});
