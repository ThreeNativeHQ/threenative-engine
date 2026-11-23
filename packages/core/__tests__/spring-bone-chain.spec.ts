import { Bone, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { SpringBoneChain3D } from "../src/spring-bone-chain.js";

const SEGMENT = 0.2;
const STEP = 1 / 60;

/** A vertical chain of `count` bones including `root`, each `SEGMENT` above its parent. */
function chainRig(count: number): { root: Bone; bones: Bone[] } {
  const root = new Bone();
  root.name = "ponytail_01";
  root.position.set(0, 1, 0);
  const bones = [root];
  for (let index = 1; index < count; index++) {
    const bone = new Bone();
    bone.name = `ponytail_0${index + 1}`;
    bone.position.set(0, SEGMENT, 0);
    (bones[index - 1] as Bone).add(bone);
    bones.push(bone);
  }
  return { root, bones };
}

function tipOf(chain: SpringBoneChain3D): Vector3 {
  return chain.particles[chain.particles.length - 1] as Vector3;
}

describe("SpringBoneChain3D", () => {
  it("rotates every chain bone, the root first, so each bone sits on its particle", () => {
    const { root, bones } = chainRig(4);
    const chain = new SpringBoneChain3D(root);
    root.position.x = 0.3;
    for (let step = 0; step < 3; step++) {
      chain.step(STEP);
      chain.particles.forEach((particle, index) => {
        const bone = bones[index + 1] as Bone;
        expect(bone.getWorldPosition(new Vector3()).distanceTo(particle)).toBeLessThan(1e-4);
      });
    }
    expect(Math.abs(root.rotation.z)).toBeGreaterThan(1e-3);
  });

  it("holds a four-bone chain at rest under no motion", () => {
    const { root } = chainRig(4);
    const chain = new SpringBoneChain3D(root);
    for (let step = 0; step < 120; step++) chain.step(STEP);
    expect(tipOf(chain).distanceTo(new Vector3(0, 1 + 3 * SEGMENT, 0))).toBeLessThan(1e-6);
  });

  it("lags one step after a sideways root move, then settles within 2 s", () => {
    const { root } = chainRig(4);
    const chain = new SpringBoneChain3D(root);
    const tip = tipOf(chain);
    root.position.x = 0.3;
    chain.step(STEP);
    expect(tip.x).toBeGreaterThan(0);
    expect(tip.x).toBeLessThan(0.3);
    for (let step = 0; step < 120; step++) chain.step(STEP);
    expect(tip.distanceTo(new Vector3(0.3, 1 + 3 * SEGMENT, 0))).toBeLessThan(0.01);
  });

  it("keeps every segment at its rest length on every step of the sideways move", () => {
    const { root, bones } = chainRig(4);
    const chain = new SpringBoneChain3D(root);
    root.position.x = 0.3;
    const parent = new Vector3();
    const child = new Vector3();
    for (let step = 0; step < 120; step++) {
      chain.step(STEP);
      for (let index = 0; index < bones.length - 1; index++) {
        (bones[index] as Bone).getWorldPosition(parent);
        (bones[index + 1] as Bone).getWorldPosition(child);
        expect(Math.abs(parent.distanceTo(child) - SEGMENT)).toBeLessThan(1e-5);
      }
    }
  });

  it("keeps every particle out of a sphere collider on the tip's path", () => {
    const { root } = chainRig(4);
    const center = new Vector3(0.15, 1 + 3 * SEGMENT, 0);
    const chain = new SpringBoneChain3D(root, {
      colliders: [{ a: center, b: center, radius: 0.08 }],
    });
    root.position.x = 0.3;
    for (let step = 0; step < 120; step++) {
      chain.step(STEP);
      for (const particle of chain.particles)
        expect(particle.distanceTo(center)).toBeGreaterThanOrEqual(0.08 - 1e-4);
    }
  });

  it("keeps a particle out of a sphere that its length constraint would pull it back into", () => {
    const { root } = chainRig(4);
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    // Pushed out of the sphere, the second particle lands off its segment length; projecting it back
    // onto that length re-enters the sphere unless collision and length are solved together.
    const center = new Vector3(-0.08, 0.3, 0);
    const chain = new SpringBoneChain3D(root, {
      colliders: [{ a: center, b: center, radius: 0.14 }],
    });
    chain.step(STEP);
    for (const particle of chain.particles)
      expect(particle.distanceTo(center)).toBeGreaterThanOrEqual(0.14 - 1e-4);
  });

  it("snaps with zero lag when the root teleports", () => {
    const { root } = chainRig(4);
    const chain = new SpringBoneChain3D(root);
    root.position.x = 3;
    chain.step(STEP);
    expect(chain.lastReset).toBe("teleport");
    expect(tipOf(chain).distanceTo(new Vector3(3, 1 + 3 * SEGMENT, 0))).toBeLessThan(1e-6);
  });

  it("rejects a negative stiffness", () => {
    const { root } = chainRig(4);
    expect(() => new SpringBoneChain3D(root, { stiffness: -1 })).toThrow(/SpringBoneChain3D/);
  });
});
