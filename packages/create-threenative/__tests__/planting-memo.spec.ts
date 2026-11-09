import { createHash } from "node:crypto";
import { DataTexture, InstancedMesh, Mesh, Texture } from "three";
import { describe, expect, it } from "vitest";
import { buildCourse, makeRng } from "../templates/collectathon/src/level/Course.js";
import {
  type IPlantingRecord,
  type IPlantingSite,
  buildPlanting,
  checkedPlanting,
  planPlanting,
} from "../templates/collectathon/src/render/foliage.js";
import type { ISurfaces } from "../templates/collectathon/src/render/surface.js";

/**
 * Hop Garden's island is the same every run of one build, so a repeat run reads its planting back
 * from `ctx.assets.memo` instead of drawing it (PRD-860). These are the invariants that keep that
 * honest: one seed draws one island, a stored record is read straight into the instance arrays,
 * and the built meshes do not know which of the two happened.
 */
function fakeSurfaces(): ISurfaces {
  const texture = (): Texture => {
    const made = new Texture();
    made.image = { height: 4, width: 4 };
    return made;
  };
  return {
    albedo: new Proxy({}, { get: texture }),
    normal: new Proxy({}, { get: texture }),
    noise: new DataTexture(new Uint8Array(64 * 64), 64, 64),
  } as unknown as ISurfaces;
}

/** A flat 12 m island with no path and no landmarks: every generator still runs, on little data. */
function flatSite(): IPlantingSite {
  return {
    bounds: { maxX: 12, maxZ: 12, minX: 0, minZ: 0 },
    clear: () => true,
    flatness: () => 1,
    grassShare: 1,
    ground: () => 0,
    lawns: [],
    pathDistance: () => 99,
    rng: makeRng(7),
    seaLevel: -2,
    shores: [],
    surfaces: fakeSurfaces(),
  };
}

/** Every placement the built meshes carry, in traversal order: what a player sees. */
async function courseHash(memo?: Parameters<typeof buildCourse>[3]): Promise<string> {
  const course = await buildCourse(makeRng(6402), fakeSurfaces(), 1, memo);
  const hash = createHash("sha256");
  course.group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    hash.update(
      `${object.name}|${object.type}|${object.geometry.attributes.position?.count ?? 0}|`,
    );
    if (!(object instanceof InstancedMesh)) return;
    hash.update(`count:${object.count}|matrices:${object.instanceMatrix.array.join(",")}|`);
    hash.update(
      `colours:${object.instanceColor === null ? "none" : Array.from(object.instanceColor.array).join(",")}|`,
    );
  });
  return hash.digest("hex");
}

describe("the island's planting between runs", () => {
  // A one-shot map standing in for `ctx.assets.memo`: the second call reads what the first stored.
  const stored = new Map<string, IPlantingRecord>();
  const memo = (async (key: string, build: () => unknown) => {
    const kept = stored.get(key);
    if (kept !== undefined) return kept;
    const value = (await build()) as IPlantingRecord;
    stored.set(key, value);
    return value;
  }) as Parameters<typeof buildCourse>[3];

  it("draws one island from one seed, so a stored record is the planet's own", () => {
    const first = planPlanting(flatSite());
    const second = planPlanting(flatSite());
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(first.trunks.length + first.cellValues.length + first.cards.length).toBeGreaterThan(0);
  });

  it("accepts the record it drew, and refuses one a disk could not have written", () => {
    const plan = planPlanting(flatSite());
    expect(checkedPlanting(plan)).toBe(plan);
    expect(() => checkedPlanting({ ...plan, trunks: plan.trunks.subarray(0, 10) })).toThrow(
      /stored planting is malformed/u,
    );
    expect(() => checkedPlanting({ ...plan, cards: plan.cards.subarray(0, 15) })).toThrow(
      /stored planting is malformed/u,
    );
    expect(() => checkedPlanting({ ...plan, tuftDraws: new Float64Array() })).toThrow(
      /stored planting is malformed/u,
    );
  });

  it("builds the same meshes whether the island was drawn or kept", async () => {
    const drawn = await courseHash();
    expect(await courseHash(memo)).toBe(drawn);
    expect(await courseHash(memo)).toBe(drawn);
  });

  it("plants the island's meshes from the record alone", () => {
    const site = flatSite();
    const record = planPlanting(site);
    const built = buildPlanting(record, site);
    expect(built.group.name).toBe("planting");
    expect(built.meadow.total).toBe(record.cellValues.length / 9);
  });
});
