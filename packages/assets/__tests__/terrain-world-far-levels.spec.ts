import { rm } from "node:fs/promises";
import path from "node:path";
import { Terrain } from "@threenative/terrain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { cookTerrainWorld } from "../src/world/terrain-world.js";

const thinning = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../src/lod/generate.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lod/generate.js")>();
  return {
    ...original,
    thinCoveringCards: (...args: Parameters<typeof original.thinCoveringCards>) => {
      if (thinning.error) throw thinning.error;
      return original.thinCoveringCards(...args);
    },
  };
});

const fir = path.resolve("packages/terrain/starter-assets/fir_tree_01");
function cook(out: string) {
  const state = new Terrain({ resolution: 33, seed: 73, size: 256 })
    .scatter({ id: "firs", asset: "fir", count: 40, minDistance: 3 })
    .evaluate();
  return cookTerrainWorld({
    state,
    species: {
      fir: {
        glb: path.join(fir, "fir-b-lod1.glb"),
        lods: [{ distance: 45, glb: path.join(fir, "fir-b-lod2.glb") }],
        maxDistance: 600,
      },
    },
    out,
  });
}

describe("far-level derivation failures", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir("strata-terrain-far-");
  });
  afterEach(async () => {
    thinning.error = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the authored chain when the cards cannot be thinned, and says nothing else", async () => {
    thinning.error = new Error("thinFoliageCards requires static triangle card sets.");
    const result = await cook(dir);
    expect(result.manifest.assets.fir?.lods).toHaveLength(1);
  });

  it("fails the cook on any other thinning error instead of dropping every far level (audit TERRAIN-12)", async () => {
    thinning.error = new TypeError("cannot read properties of undefined");
    await expect(cook(dir)).rejects.toThrow("cannot read properties of undefined");
  });
});
