/**
 * PRD-784 P5-9: animation-composition's pose.ts solves its arm with three's CCDIKSolver addon, which the
 * native profile did not bind. The port against three's own solver on the same 3-bone rig: the same
 * bone quaternions within 1e-5, and the effector closer to the target than before.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CCDIKSolver } from "../src/addons/ccd-ik-solver.js";

// biome-ignore lint/suspicious/noExplicitAny: upstream three's own classes, untyped here.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three")).href);
const upstream: Loose = await import(
  pathToFileURL(fromCore.resolve("three/addons/animation/CCDIKSolver.js")).href
);

// root -> upper -> lower -> hand (the effector), plus a target bone under the root.
function rig() {
  const bones = Array.from({ length: 5 }, (_, i) => Object.assign(new T.Bone(), { name: `b${i}` }));
  const [root, upper, lower, hand, target] = bones;
  root.add(upper);
  upper.add(lower);
  lower.add(hand);
  root.add(target);
  upper.position.set(0, 1, 0);
  lower.position.set(0, 1, 0);
  hand.position.set(0, 1, 0);
  target.position.set(1.2, 1.4, 0.3);
  const mesh = new T.SkinnedMesh(new T.BufferGeometry(), new T.MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new T.Skeleton(bones));
  mesh.updateMatrixWorld(true);
  return { mesh, bones, hand, target };
}

const distance = ({ hand, target }: Loose) =>
  hand.getWorldPosition(new T.Vector3()).distanceTo(target.getWorldPosition(new T.Vector3()));

describe("CCDIKSolver port", () => {
  const chains: Loose[] = [
    [{ target: 4, effector: 3, links: [{ index: 2 }, { index: 1 }], iteration: 12 }],
    [
      {
        target: 4,
        effector: 3,
        links: [
          { index: 2, limitation: new T.Vector3(1, 0, 0) },
          { index: 1, rotationMin: new T.Vector3(-1, -1, -1), rotationMax: new T.Vector3(1, 1, 1) },
        ],
        iteration: 6,
        blendFactor: 0.7,
        maxAngle: 0.5,
      },
    ],
  ];
  for (const [n, iks] of chains.entries()) {
    it(`moves the effector toward the target as three's solver does (chain ${n})`, () => {
      const ours = rig();
      const theirs = rig();
      const before = distance(ours);
      new CCDIKSolver(ours.mesh, iks).update();
      new upstream.CCDIKSolver(theirs.mesh, iks).update();
      expect(distance(ours)).toBeLessThan(before);
      for (const [i, bone] of ours.bones.entries())
        for (const [k, value] of theirs.bones[i].quaternion.toArray().entries())
          expect(Math.abs(bone.quaternion.toArray()[k] - value)).toBeLessThan(1e-5);
    });
  }

  it("refuses createHelper by name", () => {
    expect(() => new CCDIKSolver(rig().mesh, []).createHelper()).toThrow(
      "TN_NATIVE_UNSUPPORTED_CCDIKHELPER",
    );
  });
});
