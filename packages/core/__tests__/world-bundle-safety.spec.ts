import { Color } from "three";
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
    // ~1,290 rows: a shipped foliage surface measured 1,371 rows and 21,234 links.
    const painted = material(chain(500));
    const safety = new BundleSurfaceSafety();
    settle(safety, painted, 3);
    expect(safety.stats.uncached).toBe(0);
    expect(safety.stats.refreshes).toBe(1);
  });

  it("spreads deep proofs over a load-sized period, capped at 60 frames, and proves every material", () => {
    const forest = Array.from({ length: 30 }, () => material(chain(1000)));
    const safety = new BundleSurfaceSafety();
    safety.beginFrame();
    for (const painted of forest) safety.test(painted);
    const proved = new Set<MeshStandardNodeMaterial>();
    let validations = safety.stats.validations;
    // 30 graphs of ~2,600 rows over a 1,024-row budget would be a 76-frame period; the cap holds 60.
    for (let frame = 0; frame < 130; frame++) {
      safety.beginFrame();
      for (const painted of forest) {
        safety.test(painted);
        if (safety.stats.validations > validations) proved.add(painted);
        validations = safety.stats.validations;
      }
    }
    expect(safety.stats.staleFrames).toBe(60);
    expect(safety.stats.deferred).toBeGreaterThan(0);
    expect(proved.size).toBe(forest.length);
    expect(safety.stats.refreshes).toBe(forest.length);
  });
});
