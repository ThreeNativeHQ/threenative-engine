import { describe, expect, it } from "vitest";
import {
  DirectionalClipmap,
  type IVector3Like,
  PhysicalPagePool,
  ReceiverDemandPass,
  ShadowInvalidationTracker,
  makePageKey,
  parsePageKey,
} from "../src/render/virtual-shadow-pages.js";

const dot = (a: IVector3Like, b: IVector3Like) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: IVector3Like, b: IVector3Like): IVector3Like => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (v: IVector3Like) => Math.sqrt(dot(v, v));

/** A light straight overhead: `u` runs along +x and `v` along -z. */
function verticalClipmap(clipExtents: number[], pagesPerAxis = 8): DirectionalClipmap {
  return new DirectionalClipmap({ direction: { x: 0, y: 1, z: 0 }, clipExtents, pagesPerAxis });
}

describe("page keys", () => {
  it("preserve signed absolute coordinates", () => {
    const key = makePageKey(3, -17, 42);
    expect(key).toBe("3:-17:42");
    expect(parsePageKey(key)).toEqual({ level: 3, x: -17, y: 42 });
  });

  it("fail closed on non-integers and malformed keys", () => {
    expect(() => makePageKey(0.5, 0, 0)).toThrow(/integer/u);
    expect(() => parsePageKey("1:2")).toThrow(/invalid page key/u);
    expect(() => parsePageKey("a:b:c")).toThrow(/invalid page key/u);
  });
});

describe("PhysicalPagePool", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new PhysicalPagePool(0)).toThrow(/capacity/u);
  });

  it("reuses a resident page without allocating a second slot", () => {
    const pool = new PhysicalPagePool(4);
    const key = makePageKey(0, 3, -2);
    const first = pool.allocate(key, { frame: 1 });
    const second = pool.allocate(key, { frame: 2 });
    expect(second?.reused).toBe(true);
    expect(second?.entry.slot).toBe(first?.entry.slot);
    expect(second?.entry.lastUsedFrame).toBe(2);
    expect(pool.size).toBe(1);
  });

  it("evicts the least recently used unpinned unprotected page", () => {
    const pool = new PhysicalPagePool(4);
    const [a, b, c, d, e] = [0, 1, 2, 3, 4].map((x) => makePageKey(0, x, 0)) as [
      string,
      string,
      string,
      string,
      string,
    ];
    pool.allocate(a, { frame: 1, pinned: true });
    pool.allocate(b, { frame: 2 });
    pool.allocate(c, { frame: 3 });
    pool.allocate(d, { frame: 4 });

    const result = pool.allocate(e, { frame: 5, protectedKeys: new Set([b]) });
    expect(result?.evictedKey).toBe(c);
    expect(result?.entry.slot).toBe(2);
    expect(pool.has(a)).toBe(true);
    expect(pool.has(b)).toBe(true);
    expect(pool.has(c)).toBe(false);
    expect(pool.has(e)).toBe(true);
    expect(pool.evictions).toBe(1);
  });

  it("uses the slot number as a stable tie breaker for equal LRU frames", () => {
    const pool = new PhysicalPagePool(4);
    const keys = [0, 1, 2, 3].map((x) => makePageKey(0, x, 0));
    for (const key of keys) pool.allocate(key, { frame: 1 });
    const next = pool.allocate(makePageKey(0, 9, 0), { frame: 2 });
    expect(next?.evictedKey).toBe(keys[0]);
    expect(next?.entry.slot).toBe(0);
  });

  it("reports overflow rather than evicting pinned or protected pages", () => {
    const pool = new PhysicalPagePool(1);
    const pinned = makePageKey(3, 0, 0);
    pool.allocate(pinned, { frame: 1, pinned: true });
    expect(pool.allocate(makePageKey(0, 1, 1), { frame: 2 })).toBeNull();
    expect(pool.overflow).toBe(1);
    expect(pool.has(pinned)).toBe(true);
  });

  it("marks new pages dirty and invalidates individually or globally", () => {
    const pool = new PhysicalPagePool(4);
    const a = makePageKey(0, 0, 0);
    const b = makePageKey(1, 0, 0);
    pool.allocate(a, { frame: 1 });
    pool.allocate(b, { frame: 1 });
    expect(pool.get(a)?.dirty).toBe(true);
    for (const key of [a, b]) {
      const entry = pool.get(key);
      if (entry) entry.dirty = false;
    }
    expect(pool.markDirty(a)).toBe(true);
    expect(pool.get(a)?.dirty).toBe(true);
    expect(pool.get(b)?.dirty).toBe(false);
    expect(pool.markAllDirty()).toBe(2);
    expect(pool.get(b)?.dirty).toBe(true);
  });

  it("returns a released slot to the deterministic free list", () => {
    const pool = new PhysicalPagePool(4);
    const a = makePageKey(0, 0, 0);
    pool.allocate(a, { frame: 1 });
    pool.allocate(makePageKey(0, 1, 0), { frame: 1 });
    expect(pool.release(a)).toBe(true);
    expect(pool.allocate(makePageKey(0, 2, 0), { frame: 2 })?.entry.slot).toBe(0);
    expect(pool.size).toBe(2);
  });
});

describe("DirectionalClipmap", () => {
  it("rejects malformed construction", () => {
    expect(
      () =>
        new DirectionalClipmap({
          direction: { x: 0, y: 0, z: 0 },
          clipExtents: [1],
          pagesPerAxis: 2,
        }),
    ).toThrow(/non-zero/u);
    expect(
      () =>
        new DirectionalClipmap({
          direction: { x: 0, y: 1, z: 0 },
          clipExtents: [],
          pagesPerAxis: 2,
        }),
    ).toThrow(/clipExtents/u);
    expect(
      () =>
        new DirectionalClipmap({
          direction: { x: 0, y: 1, z: 0 },
          clipExtents: [4, 2],
          pagesPerAxis: 2,
        }),
    ).toThrow(/increase/u);
    expect(
      () =>
        new DirectionalClipmap({
          direction: { x: 0, y: 1, z: 0 },
          clipExtents: [4],
          pagesPerAxis: 2,
          selectionGuard: 0,
        }),
    ).toThrow(/selectionGuard/u);
  });

  it("builds an orthonormal light-space basis", () => {
    const clipmap = new DirectionalClipmap({
      direction: { x: 0.55, y: 1, z: 0.35 },
      clipExtents: [16, 32],
      pagesPerAxis: 8,
    });
    expect(length(clipmap.basisU)).toBeCloseTo(1, 9);
    expect(length(clipmap.basisV)).toBeCloseTo(1, 9);
    expect(length(clipmap.basisW)).toBeCloseTo(1, 9);
    expect(dot(clipmap.basisU, clipmap.basisV)).toBeCloseTo(0, 9);
    expect(dot(clipmap.basisU, clipmap.basisW)).toBeCloseTo(0, 9);
    expect(dot(clipmap.basisV, clipmap.basisW)).toBeCloseTo(0, 9);
  });

  it("is right-handed so a page camera with up = V renders screen X = +U", () => {
    // The prototype built V = U x W, a left-handed basis, and every rendered page came out
    // mirrored along u against the sampler. A camera placed along +W with up = V has
    // screen X = V x W, so that must equal +U (equivalently U x V = W).
    const clipmap = new DirectionalClipmap({
      direction: { x: 0.56, y: 1, z: 0.36 },
      clipExtents: [16],
      pagesPerAxis: 8,
    });
    const screenX = cross(clipmap.basisV, clipmap.basisW);
    expect(screenX.x).toBeCloseTo(clipmap.basisU.x, 9);
    expect(screenX.y).toBeCloseTo(clipmap.basisU.y, 9);
    expect(screenX.z).toBeCloseTo(clipmap.basisU.z, 9);
    expect(dot(cross(clipmap.basisU, clipmap.basisV), clipmap.basisW)).toBeCloseTo(1, 9);
  });

  it("snaps clip windows to whole page increments", () => {
    const clipmap = verticalClipmap([16]);
    clipmap.updateCenter({ x: 0.2, y: 2, z: -0.2 });
    const first = clipmap.getWindow(0);
    clipmap.updateCenter({ x: 3.9, y: 2, z: -3.9 });
    const subPageMove = clipmap.getWindow(0);
    clipmap.updateCenter({ x: 4.1, y: 2, z: -4.1 });
    const boundaryMove = clipmap.getWindow(0);
    expect({ minX: subPageMove.minX, minY: subPageMove.minY }).toEqual({
      minX: first.minX,
      minY: first.minY,
    });
    expect(boundaryMove.minX).toBe(first.minX + 1);
    expect(boundaryMove.minY).toBe(first.minY + 1);
    expect(first.pageWorldSize).toBe(4);
  });

  it("keeps every origin on its texel grid with independent refresh thresholds", () => {
    const clipmap = new DirectionalClipmap({
      direction: { x: 0, y: 1, z: 0 },
      clipExtents: [24, 96, 320],
      pagesPerAxis: 512,
      refreshStep: [0.25, 0.125, 0.164],
    });
    clipmap.updateCenter(clipmap.unproject({ u: 100, v: -100 }));
    const origins = clipmap.clipExtents.map((_, level) => clipmap.getWindow(level));
    const fine = origins[0];
    if (!fine) throw new Error("missing finest window");
    clipmap.updateCenter(
      clipmap.unproject({
        u: 100 + fine.refreshPages * fine.pageWorldSize + fine.pageWorldSize,
        v: -100,
      }),
    );
    expect(clipmap.getWindow(0).minX).not.toBe(fine.minX);
    for (const level of [1, 2]) {
      expect(clipmap.getWindow(level)).toEqual(origins[level]);
    }
    for (const u of [123.456, -321.789, -1000, 1000]) {
      for (const window of clipmap.updateCenter(clipmap.unproject({ u, v: -u }))) {
        for (const origin of [window.minX, window.minY, window.maxX, window.maxY]) {
          expect(Number.isInteger(origin)).toBe(true);
          const worldOrigin = origin * window.pageWorldSize;
          expect(worldOrigin / window.pageWorldSize).toBeCloseTo(origin, 9);
        }
      }
    }
  });

  it("does not move a stationary window when its refresh threshold shrinks below its drift", () => {
    const clipmap = new DirectionalClipmap({
      direction: { x: 0, y: 1, z: 0 },
      clipExtents: [320],
      pagesPerAxis: 512,
      refreshStep: 0.164,
    });
    clipmap.updateCenter(clipmap.unproject({ u: 100, v: -100 }));
    const origin = clipmap.getWindow(0);
    const followed = clipmap.unproject({ u: 110, v: -110 });
    clipmap.updateCenter(followed);
    clipmap.setRefreshStep(0, 0);
    clipmap.updateCenter(followed);
    expect(clipmap.getWindow(0)).toMatchObject({ minX: origin.minX, minY: origin.minY });
    clipmap.updateCenter(clipmap.unproject({ u: 110 + origin.pageWorldSize, v: -110 }));
    expect(clipmap.getWindow(0).minX).not.toBe(origin.minX);
    expect(clipmap.getWindow(0).minY).toBe(Math.floor(-110 / origin.pageWorldSize) - 256);
  });

  it("changes only the requested level when a scalar refresh step was supplied", () => {
    const clipmap = verticalClipmap([24, 96, 320], 512);
    clipmap.setRefreshStep(1, 0.164);
    expect(clipmap.refreshStep).toEqual([0.125, 0.164, 0.125]);
  });

  it("uses floor addressing for negative virtual page coordinates", () => {
    const clipmap = verticalClipmap([16]);
    expect(clipmap.worldToPage({ x: -0.01, y: 0, z: 0.01 }, 0)).toEqual({
      level: 0,
      x: -1,
      y: -1,
      key: "0:-1:-1",
    });
  });

  it("projects axis-aligned world bounds into exact light-space page ranges", () => {
    const clipmap = verticalClipmap([16]);
    expect(
      clipmap.boundsToPageKeys({ min: { x: 3, y: 0, z: -2 }, max: { x: 9, y: 5, z: 2 } }, 0),
    ).toEqual(["0:0:-1", "0:0:0", "0:1:-1", "0:1:0", "0:2:-1", "0:2:0"]);
  });

  it("selects the finest clip whose guarded extent contains the point", () => {
    const clipmap = new DirectionalClipmap({
      direction: { x: 0, y: 1, z: 0 },
      clipExtents: [8, 16, 32],
      pagesPerAxis: 8,
      selectionGuard: 0.9,
    });
    clipmap.updateCenter({ x: 0, y: 0, z: 0 });
    expect(clipmap.selectLevel({ x: 3, y: 0, z: 0 })).toBe(0);
    expect(clipmap.selectLevel({ x: 10, y: 0, z: 0 })).toBe(1);
    expect(clipmap.selectLevel({ x: 25, y: 0, z: 0 })).toBe(2);
  });

  it("reports a direction change so cached pages can be dropped", () => {
    const clipmap = verticalClipmap([16]);
    expect(clipmap.setDirection({ x: 0, y: 2, z: 0 })).toBe(false);
    expect(clipmap.setDirection({ x: 1, y: 1, z: 0 })).toBe(true);
  });

  it("unprojects a page centre back onto the light-space plane", () => {
    const clipmap = verticalClipmap([16]);
    const page = clipmap.pageBounds(0, 1, -1);
    const projected = clipmap.project(page.centerWorld);
    expect(projected.u).toBeCloseTo(page.centerU, 9);
    expect(projected.v).toBeCloseTo(page.centerV, 9);
    expect(projected.w).toBeCloseTo(0, 9);
  });
});

describe("ReceiverDemandPass", () => {
  it("deduplicates receiver samples and prioritises fine pages near the camera", () => {
    const clipmap = verticalClipmap([8, 16, 32], 4);
    clipmap.updateCenter({ x: 0, y: 0, z: 0 });
    const requests = new ReceiverDemandPass({ guardBand: 0 }).collect({
      cameraPosition: { x: 0, y: 8, z: 0 },
      receiverPoints: [
        { x: 1, y: 0, z: 1 },
        { x: 1, y: 0, z: 1 },
        { x: 10, y: 0, z: 0 },
      ],
      visibleBounds: [],
      clipmap,
    });
    const nonPinned = requests.filter((request) => !request.pinned);
    expect(new Set(requests.map((request) => request.key)).size).toBe(requests.length);
    expect(nonPinned.some((request) => request.level === 0)).toBe(true);
    expect(nonPinned.some((request) => request.level === 1)).toBe(true);
    expect(nonPinned[0]?.level).toBe(0);
  });

  it("pins every page in the coarsest current clip window", () => {
    const clipmap = verticalClipmap([8, 16], 4);
    clipmap.updateCenter({ x: 0, y: 0, z: 0 });
    const requests = new ReceiverDemandPass({ guardBand: 0 }).collect({
      cameraPosition: { x: 0, y: 8, z: 0 },
      receiverPoints: [],
      visibleBounds: [],
      clipmap,
    });
    const pinned = requests.filter((request) => request.pinned);
    expect(pinned).toHaveLength(16);
    expect(pinned.every((request) => request.level === 1)).toBe(true);
    expect(new Set(pinned.map(({ x }) => x))).toEqual(new Set([-2, -1, 0, 1]));
  });

  it("adds a one-page guard band without requesting outside the active window", () => {
    const clipmap = verticalClipmap([8, 16], 4);
    clipmap.updateCenter({ x: 0, y: 0, z: 0 });
    const requests = new ReceiverDemandPass({ guardBand: 1 }).collect({
      cameraPosition: { x: 0, y: 8, z: 0 },
      receiverPoints: [{ x: 0.1, y: 0, z: -0.1 }],
      visibleBounds: [],
      clipmap,
    });
    const fine = requests.filter((request) => request.level === 0 && !request.pinned);
    const window = clipmap.getWindow(0);
    expect(fine).toHaveLength(9);
    expect(
      fine.every(
        ({ x, y }) => x >= window.minX && x < window.maxX && y >= window.minY && y < window.maxY,
      ),
    ).toBe(true);
  });

  it("lets visible bounds request pages no receiver ray touched", () => {
    const clipmap = verticalClipmap([8, 16, 32], 4);
    clipmap.updateCenter({ x: 0, y: 0, z: 0 });
    const requests = new ReceiverDemandPass({ guardBand: 0 }).collect({
      cameraPosition: { x: 0, y: 8, z: 0 },
      receiverPoints: [],
      visibleBounds: [{ min: { x: 8, y: 3, z: -1 }, max: { x: 10, y: 8, z: 1 } }],
      clipmap,
    });
    expect(requests.some((request) => !request.pinned && request.level === 1)).toBe(true);
  });

  it("rejects a malformed guard band", () => {
    expect(() => new ReceiverDemandPass({ guardBand: -1 })).toThrow(/guardBand/u);
  });
});

describe("ShadowInvalidationTracker", () => {
  const bounds = (minX: number, maxX: number) => ({
    min: { x: minX, y: 0, z: -0.8 },
    max: { x: maxX, y: 2, z: -0.2 },
  });

  it("invalidates the pages a new caster covers on every level", () => {
    const tracker = new ShadowInvalidationTracker(verticalClipmap([16, 32]));
    tracker.update("crate", bounds(0.2, 0.8));
    expect([...tracker.consumeInvalidatedKeys()].sort()).toEqual(["0:0:0", "1:0:0"]);
  });

  it("does not invalidate again for unchanged bounds", () => {
    const tracker = new ShadowInvalidationTracker(verticalClipmap([16, 32]));
    const first = bounds(0.2, 0.8);
    tracker.update("crate", first);
    tracker.consumeInvalidatedKeys();
    expect(tracker.update("crate", structuredClone(first))).toBe(false);
    expect(tracker.consumeInvalidatedKeys().size).toBe(0);
  });

  it("invalidates only the union of old and new coverage when a caster moves", () => {
    const tracker = new ShadowInvalidationTracker(verticalClipmap([16, 32]));
    tracker.update("crate", bounds(0.2, 0.8));
    tracker.consumeInvalidatedKeys();
    tracker.update("crate", bounds(4.2, 4.8));
    expect([...tracker.consumeInvalidatedKeys()].sort()).toEqual(["0:0:0", "0:1:0", "1:0:0"]);
  });

  it("invalidates the previous coverage of a removed or pruned caster", () => {
    const tracker = new ShadowInvalidationTracker(verticalClipmap([16]));
    tracker.update("crate", bounds(0.2, 0.8));
    tracker.update("barrel", bounds(8.2, 8.8));
    tracker.consumeInvalidatedKeys();
    expect(tracker.remove("crate")).toBe(true);
    expect([...tracker.consumeInvalidatedKeys()]).toEqual(["0:0:0"]);
    expect(tracker.prune(new Set())).toBe(1);
    expect([...tracker.consumeInvalidatedKeys()]).toEqual(["0:2:0"]);
    expect(tracker.trackedCount).toBe(0);
  });

  it("invalidateAll marks the current coverage of every tracked caster", () => {
    const tracker = new ShadowInvalidationTracker(verticalClipmap([16]));
    tracker.update("a", bounds(0.2, 0.8));
    tracker.update("b", bounds(8.2, 8.8));
    tracker.consumeInvalidatedKeys();
    tracker.invalidateAll();
    expect([...tracker.consumeInvalidatedKeys()].sort()).toEqual(["0:0:0", "0:2:0"]);
  });
});
