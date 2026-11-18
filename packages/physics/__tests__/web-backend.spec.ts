import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// PRD-899: the web back end picks the Rapier crate on the owned engine (`bindWebEngine` sets
// `__tnWebThreads`) and keeps rapier3d-compat for `engine: "threejs"` (no marker).
const marker = globalThis as { __tnWebThreads?: string };

async function backendVersion(): Promise<string> {
  vi.resetModules();
  await import("../src/web.js");
  const { physicsSimulationBackend } = await import("../src/simulation.js");
  const backend = physicsSimulationBackend();
  await backend.initialize();
  const simulation = backend.createSimulation();
  const version = simulation.version;
  simulation.dispose();
  return version;
}

describe("web physics back end", () => {
  afterEach(() => {
    marker.__tnWebThreads = undefined;
    vi.unstubAllGlobals();
  });

  it("runs on the Rapier crate's Wasm module under the default engine", async () => {
    marker.__tnWebThreads = "on (4)";
    const bytes = readFileSync(new URL("../wasm/threenative_native_physics.wasm", import.meta.url));
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      fetched.push(String(url));
      return new Response(bytes);
    });
    expect(await backendVersion()).toBe("0.30.0");
    expect(fetched).toEqual([expect.stringMatching(/\/wasm\/threenative_native_physics\.wasm$/)]);
  });

  it("keeps rapier3d-compat under engine threejs", async () => {
    expect(await backendVersion()).toBe("0.19.3");
  });
});
