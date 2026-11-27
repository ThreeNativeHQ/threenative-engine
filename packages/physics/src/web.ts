// `three` first: under the owned engine it resolves only once the Wasm engine is bound, so the engine
// marker read below is final when this module runs (upstream three is already loaded by the game).
import "three";
import type * as Rapier from "@dimforge/rapier3d-compat";
import { createNativePhysicsBackend } from "./native.js";
import type { INativePhysicsHost } from "./native/host.js";
import { createWasmPhysicsHost } from "./native/wasm-host.js";
import {
  type IPhysicsSimulation,
  createWebPhysicsShape,
  createWebPhysicsSimulation,
  installPhysicsSimulationBackend,
} from "./simulation.js";

// PRD-899: the default engine runs the Rust Rapier crate, the native player's own build, as a
// standalone Wasm module: one call per step, per pose read and per ray, with no wrapper objects.
// `engine: "threejs"` (no engine marker) keeps `rapier3d-compat`. `__tnWebThreads` is set by
// `bindWebEngine`, and `__tnWebEngineFallback` is set when an owned-engine page falls back to
// WebGL2 on a browser without WebGPU (the standalone Rust crate has no WebGPU dependency).
const ownedEngine =
  (globalThis as { __tnWebThreads?: unknown }).__tnWebThreads !== undefined ||
  (globalThis as { __tnWebEngineFallback?: unknown }).__tnWebEngineFallback !== undefined;

// Fetched the moment physics is imported, awaited only by `initialize`, so it downloads while the
// engine's Wasm compiles and the game boots (PRD-860). A failed fetch rejects `initialize`.
// `dist/` and `src/` are both one level below the package root, so the URL resolves in both.
let crateHost: INativePhysicsHost | undefined;
const crateReady = ownedEngine
  ? (async () => {
      const response = await fetch(
        new URL("../wasm/threenative_native_physics.wasm", import.meta.url),
      );
      if (!response.ok)
        throw new Error(`TN_PHYSICS_WASM_LOAD: physics module returned ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      crateHost = createWasmPhysicsHost(instance.exports);
    })()
  : undefined;
crateReady?.catch(() => undefined);

if (crateReady !== undefined) {
  installPhysicsSimulationBackend(
    createNativePhysicsBackend(
      () => {
        if (crateHost === undefined)
          throw new Error("Physics used before the physics backend initialized.");
        return crateHost;
      },
      () => crateReady,
    ),
  );
} else {
  installCompatBackend();
}

const RAPIER_INIT_WARNING =
  "using deprecated parameters for the initialization function; pass a single object instead";

// The `engine: "threejs"` path. A static import put Rapier's ~660 KB (Brotli) in the entry chunk;
// as its own chunk it downloads beside the game. A caller that inits Rapier itself and hands over a
// World needs the module bound once it resolves, not only after `initialize`.
function installCompatBackend(): void {
  let loaded: typeof Rapier | undefined;
  const rapierModule = import("@dimforge/rapier3d-compat").then((module) => {
    loaded = module;
    return module;
  });
  rapierModule.catch(() => undefined);
  const rapierReady = (): typeof Rapier => {
    if (loaded === undefined)
      throw new Error("Rapier used before the physics backend initialized.");
    return loaded;
  };
  let initialized: Promise<void> | undefined;
  const simulations = new WeakMap<object, IPhysicsSimulation>();

  async function initializeRapier(): Promise<void> {
    const rapier = await rapierModule;
    const previousWarn = console.warn;
    console.warn = (...args) => {
      if (args[0] === RAPIER_INIT_WARNING) return;
      previousWarn(...args);
    };
    try {
      await rapier.init().finally(() => {
        console.warn = previousWarn;
      });
    } catch (error) {
      console.warn = previousWarn;
      throw error;
    }
  }

  const wrap = (world: Rapier.World) => {
    const rapier = rapierReady();
    const simulation = createWebPhysicsSimulation({
      eventQueue: new rapier.EventQueue(true),
      rapier,
      version: rapier.version(),
      world,
    });
    simulations.set(world, simulation);
    return simulation;
  };

  installPhysicsSimulationBackend({
    initialize: () => {
      initialized ??= initializeRapier();
      return initialized;
    },
    createSimulation: (options = {}) =>
      wrap(new (rapierReady().World)(options.gravity ?? { x: 0, y: -9.81, z: 0 })),
    simulationForWorld: (world) => {
      if (typeof world !== "object" || world === null)
        throw new Error("Physics nodes expected a Rapier World.");
      return simulations.get(world) ?? wrap(world as Rapier.World);
    },
    createShape: (shape) => createWebPhysicsShape(rapierReady(), shape),
  });
}
