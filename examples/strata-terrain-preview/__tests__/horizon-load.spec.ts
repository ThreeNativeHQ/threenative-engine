import { afterEach, expect, it, vi } from "vitest";
import * as horizon from "../src/render/ground/horizon.js";

// The first root that answers wins; one root is enough to see a failure turn into a retry.
const ASSETS = { resolve: async () => ["https://assets.test/world/horizon.json"] };
const SURROUNDINGS = { tundra: { resolution: 2, size: 10, heights: [0, 1, 2, 3] } };

afterEach(() => {
  vi.unstubAllGlobals();
});

it("loads world/horizon.json again after a failed fetch instead of rethrowing it", async () => {
  // The surroundings are fetched once per page and installed in a module-level promise. A rejected
  // fetch stayed cached, so every later world load threw the first failure without asking again.
  const load = horizon.loadHorizonSurroundings;
  expect(load, "horizon.ts hands out the one cached surroundings load").toBeTypeOf("function");
  if (typeof load !== "function") return;

  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockRejectedValueOnce(new TypeError("network down"));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SURROUNDINGS)));
  vi.stubGlobal("fetch", fetchMock);

  await expect(load(ASSETS)).rejects.toThrow("Missing baked world file: world/horizon.json");
  expect(horizon.horizonSurroundings("tundra")).toBeUndefined();

  await expect(load(ASSETS)).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(horizon.horizonSurroundings("tundra")).toEqual(SURROUNDINGS.tundra);
});
