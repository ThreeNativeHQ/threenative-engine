/**
 * PRD-795 AC-2, the vista box: the meadow a view plants at load draws beside the bake's containers.
 *
 * `countProps` reads the drawn instance translations of `props.meshes` (`src/diagnostics.ts`,
 * `coverNearEye`), so this pin reads the same numbers: every drawn instance the streamed worlds
 * hold within 40 m of the eye. The bake writes its own `local:false` container; the meadow's grass
 * lands in a container of the same name, and the load keeps a live placement unless the bake wrote
 * that placement's own id.
 */
import { type IPlacement, type IPropBucketEntry, compilePropBuckets } from "@threenative/terrain";
import { InstancedMesh, Vector3 } from "three";
import { expect, it } from "vitest";
import { streamProps } from "../src/render/props/propWorld.js";
import { buildPropVariants, flatPropMaterials, variantFor } from "../src/render/props/props.js";

/** The streamed worlds the game's prop load hands back, as its callers see it. */
type IPropStreamed = NonNullable<Awaited<ReturnType<typeof streamProps>>>;

const SIZE = 512;
const EYE = { x: 0, z: 0 };

function grassAt(id: string, x: number, z: number): IPlacement {
  return {
    alignToNormal: false,
    asset: "grass",
    id,
    layer: "temperate-grass",
    normal: [0, 1, 0],
    position: [x, 0, z],
    rotation: 0,
    scale: 1,
  };
}

function entry(placement: IPlacement): IPropBucketEntry {
  return {
    bucket: "local:false",
    key: `grass:${variantFor(placement, "grass")}`,
    kind: "local",
    placement,
    reach: 112,
  };
}

/** The bake's container: two grass records 300 m from the eye, in the bake's own `local:false`. */
const BAKED = [grassAt("temperate-grass:0", 300, 300), grassAt("temperate-grass:1", -300, 280)];

/** The meadow the vista plants: three blades within 40 m, and one id the bake already wrote. */
const MEADOW = [
  grassAt("temperate-grass:meadow-0", 4, 6),
  grassAt("temperate-grass:meadow-1", -12, 9),
  grassAt("temperate-grass:meadow-2", 20, -18),
  grassAt("temperate-grass:0", 2, 2),
];

/** `countProps`' own read, `coverNearEye`: drawn instance translations within 40 m of the eye. */
function nearEye(streamed: IPropStreamed): number {
  let count = 0;
  for (const mesh of streamed.meshes) {
    if (!(mesh instanceof InstancedMesh)) continue;
    const local = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i++) {
      const dx = (local[i * 16 + 12] as number) - EYE.x;
      const dz = (local[i * 16 + 14] as number) - EYE.z;
      if (dx * dx + dz * dz < 1600) count++;
    }
  }
  return count;
}

it("draws the meadow a view plants beside a baked container of the same name", async () => {
  const materials = flatPropMaterials();
  const streamed = await streamProps({
    package: compilePropBuckets(BAKED.map(entry), {
      cellSize: 128,
      bounds: { minX: -SIZE / 2, minZ: -SIZE / 2, sizeX: SIZE, sizeZ: SIZE },
    }),
    placements: MEADOW,
    follow: { position: new Vector3(EYE.x, 0, EYE.z) },
    groundAt: () => ({ height: 0, offset: 0 }),
    materials,
    parts: buildPropVariants(),
    size: SIZE,
    horizonDistance: 5000,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error("the load was cancelled");
  try {
    // Admission runs on the world's own update, as the engine steps it; a cell's models land one
    // task after the frame that queued them (`loadedCells` counts them).
    for (let step = 0; step < 8; step++) {
      for (const world of streamed.worlds) world.update();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(streamed.byId.size).toBe(BAKED.length + 3);
    expect(nearEye(streamed)).toBe(3);
  } finally {
    streamed.dispose();
    materials.dispose();
  }
});
