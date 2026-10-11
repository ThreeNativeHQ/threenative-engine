import { Box3, BoxGeometry, MeshBasicMaterial, Object3D } from "three";
import { describe, expect, it } from "vitest";
import { CellPrewarm, type ICellPrewarmHost } from "../src/world-cell-prewarm.js";
import type { IAssetState } from "../src/world-cell-models.js";

function host(built: (key: string) => boolean): ICellPrewarmHost {
  const parent = new Object3D();
  return {
    released: () => false,
    parent: () => parent,
    invalidateShadows: () => undefined,
    backlog: () => 0,
    keysForShadow: () => false,
    hasShared: built,
    hasRetired: () => false,
    runMax: () => 1,
    residentCells: () => 1,
    extentBounds: () => new Box3(),
    smallCaster: () => false,
    dressMesh: () => undefined,
    receiveShadow: () => false,
    adoptGpu: () => undefined,
    setShared: () => undefined,
    attach: () => undefined,
    casts: () => false,
    wideOwed: () => false,
    followCluster: () => "0_0",
    wideShape: (_asset, _level, _part, fallback) => fallback,
  };
}

const asset = {
  id: "boulder",
  levels: [[{ geometry: new BoxGeometry(), material: new MeshBasicMaterial() }]],
} as unknown as IAssetState;

describe("CellPrewarm gate", () => {
  it("settles when every key an asset asks for is already built", async () => {
    const prewarm = new CellPrewarm(host(() => true));
    prewarm.queuePrewarm(asset);
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.queued).toBe(0);
    expect(prewarm.settled).toBe(true);
    await expect(prewarm.prewarmed).resolves.toBeUndefined();
  });

  it("stays open until an asset asks, so an early idle update cannot settle it", () => {
    const prewarm = new CellPrewarm(host(() => true));
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.settled).toBe(false);
  });
});
