import {
  AnimationClip,
  AnimationMixer,
  Bone,
  BoxGeometry,
  Group,
  InterpolateDiscrete,
  Matrix4,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Skeleton,
  SkinnedMesh,
} from "three";
import { assert, describe, expect, it, vi } from "vitest";
import { bakePoseTable, preparePoseBasis } from "../src/animation-pose-table.js";
import { AnimationPlayer } from "../src/animation.js";

function fixture(phase = 0) {
  const root = new Group();
  const mesh = new SkinnedMesh(new BoxGeometry(), new MeshBasicMaterial());
  const base = new Bone();
  base.name = "base";
  const joint = new Bone();
  joint.name = "joint";
  joint.position.y = 1;
  base.add(joint);
  mesh.add(base);
  mesh.bind(new Skeleton([base, joint]));
  root.add(mesh);
  const track = new NumberKeyframeTrack("joint.rotation[z]", [0, 1, 2], [-0.09, 0.09, -0.09]);
  const clip = new AnimationClip("bend", 2, [track]);
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(phase);
  root.updateMatrixWorld(true);
  return {
    root,
    mesh,
    base,
    joint,
    clip,
    mixer,
    track,
    inverse: mesh.skeleton.boneInverses[1] as Matrix4,
  };
}

describe("internal clip pose table", () => {
  it("declines an independently animated outer ancestor", () => {
    const f = fixture();
    const outer = new Group();
    outer.add(f.root);
    const player = new AnimationPlayer({
      root: outer,
      clips: [
        new AnimationClip("turn", 1, [new NumberKeyframeTrack(".rotation[y]", [0, 1], [0, 1])]),
      ],
      strideSync: false,
    });
    try {
      expect(preparePoseBasis(f.root, f.mesh, f.clip)).toBeUndefined();
    } finally {
      player.dispose();
    }
  });

  it("bakes current asset poses without touching the live mixer, rig or userData", () => {
    const f = fixture(0.73);
    f.root.position.set(3, 4, -10);
    f.root.updateMatrixWorld(true);
    f.root.userData.cycle = f.root;
    const before = f.joint.quaternion.clone();
    const basis = preparePoseBasis(f.root, f.mesh, f.clip);
    assert(basis);
    expect(basis).toBeDefined();
    const table = bakePoseTable(basis, 1 / 60, 1_000_000);
    assert(table);
    expect(table?.segments).toBe(120);
    expect(table?.data.byteLength).toBe(121 * 2 * 64);
    expect(f.mixer.time).toBe(0.73);
    expect(f.joint.quaternion.equals(before)).toBe(true);
    expect(f.root.position.toArray()).toEqual([3, 4, -10]);
    expect(f.root.userData.cycle).toBe(f.root);
    const reference = fixture();
    for (const frame of [0, 1, 60, 119]) {
      reference.mixer.setTime(frame / 60);
      reference.root.updateMatrixWorld(true);
      reference.mesh.skeleton.update();
      const actual = table.data.slice(frame * 32, (frame + 1) * 32);
      expect([...actual]).toEqual([...reference.mesh.skeleton.boneMatrices]);
    }
  });

  it("shares a rest basis across independent phases and moving roots", () => {
    const a = fixture(0.13);
    const b = fixture(1.71);
    b.root.position.set(12, 0, -120);
    const first = preparePoseBasis(a.root, a.mesh, a.clip);
    assert(first);
    const second = preparePoseBasis(b.root, b.mesh, a.clip);
    assert(second);
    expect(first.compatible(second)).toBe(true);
    a.mixer.update(0.2);
    expect(first.current()).toBe(true);
    b.base.position.x = 0.2;
    expect(second.current()).toBe(false);
    expect(first.current()).toBe(true);
  });

  it("rejects attachments, omitted ancestor bones and unsupported bindings", () => {
    const f = fixture();
    f.joint.add(new Group());
    expect(preparePoseBasis(f.root, f.mesh, f.clip)).toBeUndefined();
    f.joint.clear();
    f.mesh.skeleton = new Skeleton([f.joint], [new Matrix4()]);
    expect(preparePoseBasis(f.root, f.mesh, f.clip)).toBeUndefined();
    const other = fixture();
    other.track.name = "joint.visible";
    expect(preparePoseBasis(other.root, other.mesh, other.clip)).toBeUndefined();
  });

  it("detects inverse-bind, hierarchy and nonanimated component edits", () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.mesh.skeleton.bones.reverse();
      },
      (f: ReturnType<typeof fixture>) => {
        f.inverse.elements[12] = 1;
      },
      (f: ReturnType<typeof fixture>) => {
        f.base.remove(f.joint);
      },
      (f: ReturnType<typeof fixture>) => {
        f.joint.rotation.x = 0.2;
      },
    ]) {
      const f = fixture();
      const basis = preparePoseBasis(f.root, f.mesh, f.clip);
      assert(basis);
      edit(f);
      expect(basis.current()).toBe(false);
    }
  });

  it("declines oversized tables before running the bake mixer", () => {
    const f = fixture();
    const basis = preparePoseBasis(f.root, f.mesh, f.clip);
    assert(basis);
    const update = vi.spyOn(AnimationMixer.prototype, "setTime");
    try {
      expect(bakePoseTable(basis, 1 / 60, 64)).toBeUndefined();
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
    }
  });

  it("invalidates public clip-content and interpolation edits", () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.clip.duration = 3;
      },
      (f: ReturnType<typeof fixture>) => {
        f.track.values[0] = 0.2;
      },
      (f: ReturnType<typeof fixture>) => {
        f.track.setInterpolation(InterpolateDiscrete);
      },
      (f: ReturnType<typeof fixture>) => {
        f.track.name = "base.rotation[z]";
      },
    ]) {
      const f = fixture();
      const basis = preparePoseBasis(f.root, f.mesh, f.clip);
      assert(basis);
      edit(f);
      expect(basis.current()).toBe(false);
      expect(bakePoseTable(basis, 1 / 60, 1_000_000)).toBeUndefined();
    }
  });
});
