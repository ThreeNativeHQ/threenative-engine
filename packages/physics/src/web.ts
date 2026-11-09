import type * as Rapier from "@dimforge/rapier3d-compat";
import {
  type IPhysicsSimulation,
  createWebPhysicsShape,
  createWebPhysicsSimulation,
  installPhysicsSimulationBackend,
} from "./simulation.js";

// Fetched the moment physics is imported, awaited only by `initialize`: a static import put Rapier's
// ~660 KB (Brotli) in the entry chunk, so a first visit downloaded it before the engine could boot.
// As its own chunk it downloads while the engine's Wasm compiles and the game boots (PRD-860).
// A caller that inits Rapier itself and hands over a World needs the module bound once it resolves,
// not only after `initialize`. A failed fetch rejects `initialize`, where the game awaits it.
let loaded: typeof Rapier | undefined;
const rapierModule = import("@dimforge/rapier3d-compat").then((module) => {
  loaded = module;
  return module;
});
rapierModule.catch(() => undefined);
const rapierReady = (): typeof Rapier => {
  if (loaded === undefined) throw new Error("Rapier used before the physics backend initialized.");
  return loaded;
};
let initialized: Promise<void> | undefined;
const simulations = new WeakMap<object, IPhysicsSimulation>();
const RAPIER_INIT_WARNING =
  "using deprecated parameters for the initialization function; pass a single object instead";

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

installPhysicsSimulationBackend({
  initialize: () => {
    initialized ??= initializeRapier();
    return initialized;
  },
  createSimulation: (options = {}) => {
    const rapier = rapierReady();
    const world = new rapier.World(options.gravity ?? { x: 0, y: -9.81, z: 0 });
    const simulation = createWebPhysicsSimulation({
      eventQueue: new rapier.EventQueue(true),
      rapier,
      version: rapier.version(),
      world,
    });
    simulations.set(world, simulation);
    return simulation;
  },
  simulationForWorld: (world) => {
    if (typeof world !== "object" || world === null)
      throw new Error("Physics nodes expected a Rapier World.");
    const simulation = simulations.get(world);
    if (simulation !== undefined) return simulation;
    const rapier = rapierReady();
    const created = createWebPhysicsSimulation({
      eventQueue: new rapier.EventQueue(true),
      rapier,
      version: rapier.version(),
      world: world as Rapier.World,
    });
    simulations.set(world, created);
    return created;
  },
  createShape: (shape) => createWebPhysicsShape(rapierReady(), shape),
});
