import {
  type INativePhysicsHost,
  createNativePhysicsSimulation,
  nativePhysicsHost,
  nativeSimulation,
} from "./native/host.js";
import { type IPhysicsSimulationBackend, installPhysicsSimulationBackend } from "./simulation.js";
import type { IPhysicsSimulation } from "./simulation.js";

/**
 * The backend over a crate host: the native player's V8 binding, or on web the crate's Wasm module
 * (`native/wasm-host.ts`, PRD-899). `hostOf` is read per call, so a host installed later is seen.
 */
export function createNativePhysicsBackend(
  hostOf: () => INativePhysicsHost,
  initialize: () => Promise<void> = async () => undefined,
): IPhysicsSimulationBackend {
  const simulations = new WeakMap<object, IPhysicsSimulation>();
  const wrap = (raw: ReturnType<typeof nativeSimulation>, version: string) => {
    const simulation = createNativePhysicsSimulation(raw, version);
    simulations.set(raw, simulation);
    return simulation;
  };
  return {
    initialize,
    createSimulation: (options = {}) => {
      const host = hostOf();
      return wrap(nativeSimulation(host.createSimulation(options)), host.version);
    },
    createShape: (shape) => Object.freeze({ backend: "native", kind: shape.kind }),
    simulationForWorld: (world) => {
      if (typeof world !== "object" || world === null)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: native world must be an object");
      const existing = simulations.get(world);
      if (existing !== undefined) return existing;
      return wrap(nativeSimulation(world), hostOf().version);
    },
  };
}

installPhysicsSimulationBackend(createNativePhysicsBackend(nativePhysicsHost));
