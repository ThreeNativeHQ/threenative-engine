import { Color, Object3D } from "three";
import { Fn, float, overloadingFn, uniform, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { BundleSurfaceSafety } from "../src/world-bundle-safety.js";

/** A chain of `length` add nodes: the shape of a shipped foliage surface's graph. */
function chain(length: number): unknown {
  let node = float(0) as unknown as { add(value: number): unknown };
  for (let index = 0; index < length; index++)
    node = node.add(index) as { add(value: number): unknown };
  return node;
}

function material(colorNode: unknown): MeshStandardNodeMaterial {
  const painted = new MeshStandardNodeMaterial();
  painted.colorNode = colorNode as never;
  return painted;
}

/** Tests the material once per frame for `frames` frames and returns the checks. */
function settle(safety: BundleSurfaceSafety, painted: MeshStandardNodeMaterial, frames: number) {
  const checks = [];
  for (let frame = 0; frame < frames; frame++) {
    safety.beginFrame();
    checks.push(safety.test(painted));
  }
  return checks;
}

describe("BundleSurfaceSafety on a settled frame", () => {
  it("keeps a verdict when three's shared uniform group bumps its version every frame", () => {
    const tint = uniform(new Color(0.2, 0.5, 0.1));
    const painted = material(tint);
    const safety = new BundleSurfaceSafety();
    safety.beginFrame();
    const first = safety.test(painted);
    for (let frame = 0; frame < 4; frame++) {
      (tint.groupNode as unknown as { needsUpdate: boolean }).needsUpdate = true;
      safety.beginFrame();
      expect(safety.test(painted).revision).toBe(first.revision);
    }
    expect(safety.stats.refreshes).toBe(1);
  });

  it("ignores a private `_` cache a node rewrites every frame, as three's getChildren does", () => {
    const node = vec3(1, 0, 0);
    const painted = material(node);
    const safety = new BundleSurfaceSafety();
    safety.beginFrame();
    const first = safety.test(painted);
    for (let frame = 0; frame < 4; frame++) {
      Reflect.set(node, "_output", { frame });
      safety.beginFrame();
      expect(safety.test(painted).revision).toBe(first.revision);
    }
    expect(safety.stats.refreshes).toBe(1);
  });

  it("caches a graph holding a callable Fn child instead of re-walking it each frame", () => {
    const one = Fn(() => vec3(1, 0, 0)).setLayout({ name: "tnOne", type: "vec3", inputs: [] });
    const two = Fn(() => vec3(0, 1, 0)).setLayout({ name: "tnTwo", type: "vec3", inputs: [] });
    const painted = material(overloadingFn([one, two] as never[])());
    const safety = new BundleSurfaceSafety();
    const checks = settle(safety, painted, 4);
    expect(checks.every((check) => check.safe)).toBe(true);
    expect(safety.stats.uncached).toBe(0);
    expect(safety.stats.refreshes).toBe(1);
  });

  it("caches a graph past the old 1,024-row witness cap", () => {
    // 1,289 rows and 22,542 links: a shipped foliage surface measured 1,371 rows and 21,234 links.
    const painted = material(chain(640));
    const safety = new BundleSurfaceSafety();
    safety.beginFrame();
    expect(safety.test(painted).rows.length).toBeGreaterThan(1_024);
    settle(safety, painted, 2);
    expect(safety.stats.uncached).toBe(0);
    expect(safety.stats.refreshes).toBe(1);
  });

  it("spreads deep proofs over a load-sized period, capped at 600 frames, and proves every material", () => {
    // A foliage graph measures 2,009 rows today (three 0.187.0, 048e6bea2). 90 of them over the
    // 256-row budget ask a ~707-frame period, so the cap holds 600.
    const forest = Array.from({ length: 90 }, () => material(chain(1000)));
    const safety = new BundleSurfaceSafety();
    safety.beginFrame();
    for (const painted of forest) safety.test(painted);
    const proved = new Set<MeshStandardNodeMaterial>();
    let validations = safety.stats.validations;
    for (let frame = 0; frame < 1210; frame++) {
      safety.beginFrame();
      for (const painted of forest) {
        safety.test(painted);
        if (safety.stats.validations > validations) proved.add(painted);
        validations = safety.stats.validations;
      }
    }
    expect(safety.stats.staleFrames).toBe(600);
    expect(safety.stats.deferred).toBeGreaterThan(0);
    expect(proved.size).toBe(forest.length);
    expect(safety.stats.refreshes).toBe(forest.length);
  });

  it("proves no deep row for a renderer that records its own bundles, and still refreshes on a version bump", () => {
    const painted = material(chain(20));
    const safety = new BundleSurfaceSafety();
    for (let frame = 0; frame < 8; frame++) {
      safety.beginFrame();
      expect(safety.test(painted, false).safe).toBe(true);
    }
    expect(safety.stats.validations).toBe(0);
    expect(safety.stats.refreshes).toBe(1);
    painted.needsUpdate = true;
    safety.beginFrame();
    safety.test(painted, false);
    expect(safety.stats.refreshes).toBe(2);
  });

  it("asks the owned engine once a frame which materials moved instead of reading each one", () => {
    // The engine's state of each material's three witnessed flags, which the engine's own check reads.
    const engine = new WeakMap<object, Record<string, unknown>>();
    let reads = 0;
    const painted = material(chain(4));
    const own: Record<string, unknown> = { transparent: false, visible: true, transmission: 0 };
    engine.set(painted, { ...own });
    for (const key of Object.keys(own))
      Object.defineProperty(painted, key, {
        configurable: true,
        get: () => {
          reads++;
          return own[key];
        },
        set: (value: unknown) => {
          own[key] = value;
          (engine.get(painted) as Record<string, unknown>)[key] = value;
        },
      });
    let watched: { material: object; stamp: string }[] = [];
    const stamp = (target: object) => JSON.stringify(engine.get(target));
    const proto = Object3D.prototype as unknown as Record<string, unknown>;
    let checks = 0;
    proto.__tnMaterialWatch = (materials: object[]) => {
      watched = materials.map((target) => ({ material: target, stamp: stamp(target) }));
      return watched.length;
    };
    proto.__tnMaterialCheck = () => {
      checks++;
      return watched.flatMap((entry, index) =>
        stamp(entry.material) === entry.stamp ? [] : [index],
      );
    };
    try {
      const safety = new BundleSurfaceSafety();
      safety.beginFrame();
      const first = safety.test(painted, false);
      const proved = reads;
      checks = 0;
      for (let frame = 0; frame < 6; frame++) {
        safety.beginFrame();
        expect(safety.test(painted, false)).toBe(first);
      }
      // Six settled frames: one engine check each and no flag read in JS.
      expect(checks).toBe(6);
      expect(reads).toBe(proved);
      painted.transparent = true;
      safety.beginFrame();
      const moved = safety.test(painted, false);
      expect(moved).not.toBe(first);
      expect(moved.transparent).toBe(true);
      safety.beginFrame();
      expect(safety.test(painted, false)).toBe(moved);
    } finally {
      Reflect.deleteProperty(proto, "__tnMaterialWatch");
      Reflect.deleteProperty(proto, "__tnMaterialCheck");
    }
  });
});
