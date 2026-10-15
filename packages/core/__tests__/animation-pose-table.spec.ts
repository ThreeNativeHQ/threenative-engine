import {
  AdditiveAnimationBlendMode,
  AnimationClip,
  AnimationMixer,
  Bone,
  BoxGeometry,
  Group,
  InterpolateDiscrete,
  InterpolateSmooth,
  Matrix4,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Skeleton,
  SkinnedMesh,
} from "three";
import { StorageBufferAttribute } from "three/webgpu";
import { assert, describe, expect, it, vi } from "vitest";
import { bakePoseTable, preparePoseBasis } from "../src/animation-pose-table.js";
import { AnimationPlayer } from "../src/animation.js";
import { SkinnedBatch } from "../src/projection-skinned.js";

const limits = {
  maxStorageBufferBindingSize: 1_000_000,
  maxBufferSize: 2_000_000,
  maxStorageBuffersPerShaderStage: 8,
};

function playback(rate: number, clip?: AnimationClip) {
  const f = fixture();
  f.mixer.stopAllAction();
  f.track = new NumberKeyframeTrack("joint.position[x]", [0, 1, 2], [0, 1, 0]);
  f.clip = clip ?? new AnimationClip("bend", 2, [f.track]);
  const player = new AnimationPlayer({
    root: f.root,
    clips: [f.clip],
    strideSync: false,
    updateRate: rate,
  });
  player.play("bend");
  player.update(0, true);
  return { ...f, player };
}

function draw(batch: SkinnedBatch, f: ReturnType<typeof playback>) {
  f.root.updateMatrixWorld(true);
  batch.begin();
  batch.write(batch.claim(f.mesh) as number, f.mesh);
  batch.end();
}

function expectDisplayed(batch: SkinnedBatch, f: ReturnType<typeof playback>, slot = 0) {
  f.root.updateMatrixWorld(true);
  f.mesh.skeleton.update();
  const bones = f.mesh.skeleton.boneMatrices;
  assert(bones);
  const stride = f.mesh.skeleton.bones.length * 16;
  const actual = batch.palette.subarray(slot * stride, (slot + 1) * stride);
  for (let bone = 0; bone < f.mesh.skeleton.bones.length; bone += 1) {
    const expected = f.mesh.matrixWorld
      .clone()
      .multiply(f.mesh.bindMatrixInverse)
      .multiply(new Matrix4().fromArray(bones, bone * 16))
      .multiply(f.mesh.bindMatrix);
    for (let at = 0; at < 16; at += 1)
      expect(actual[bone * 16 + at]).toBeCloseTo(expected.elements[at] as number, 5);
  }
}

describe("current-time batch lookup", () => {
  it("drops lookup pose state when the player is disposed before the batch", () => {
    const f = playback(8);
    const batch = new SkinnedBatch({
      first: f.mesh,
      capacity: 1,
      velocity: true,
      lookupLimits: limits,
    });
    try {
      f.player.update(1 / 60, true);
      draw(batch, f);
      const previous = batch.palette.slice();
      f.player.dispose();
      f.root.position.x = 3;
      draw(batch, f);
      expectDisplayed(batch, f);
      expect([...(batch.history as Float32Array)]).toEqual([...previous]);
    } finally {
      batch.dispose();
      f.player.dispose();
    }
  });

  it("declines lookup when a clip track is replaced before its first draw", () => {
    const actual = playback(8);
    const expected = playback(1);
    const batch = new SkinnedBatch({
      first: actual.mesh,
      capacity: 1,
      velocity: true,
      lookupLimits: limits,
    });
    try {
      actual.player.update(1 / 60);
      expected.player.update(1 / 60);
      actual.track.values = new Float32Array([0, 2, 0]);
      draw(batch, actual);
      expectDisplayed(batch, expected);
    } finally {
      batch.dispose();
      actual.player.dispose();
      expected.player.dispose();
    }
  });

  it.each(["first", "forced", "scheduled"])(
    "preserves a public bone edit after the %s evaluation",
    (evaluation) => {
      const f = playback(8);
      const batch = new SkinnedBatch({
        first: f.mesh,
        capacity: 1,
        velocity: true,
        lookupLimits: limits,
      });
      try {
        if (evaluation !== "first") {
          f.player.update(1 / 60);
          draw(batch, f);
        }
        if (evaluation === "scheduled") {
          for (let tick = 0; tick < 8; tick += 1) {
            f.player.update(1 / 60);
            if (f.player.updateRateReport.evaluated) break;
            draw(batch, f);
          }
          expect(f.player.updateRateReport.evaluated).toBe(true);
        } else f.player.update(1 / 60, true);
        const previous = batch.palette.slice();
        f.joint.position.x = 0.9;
        draw(batch, f);
        expectDisplayed(batch, f);
        expect(f.player.updateRateReport.rate).toBe(1);
        if (evaluation !== "first")
          expect([...(batch.history as Float32Array)]).toEqual([...previous]);
      } finally {
        batch.dispose();
        f.player.dispose();
      }
    },
  );

  it.each(["first", "retained", "unsupported", "rate1"])(
    "preserves simultaneous clip and bone edits with %s lookup state",
    (state) => {
      const f = playback(state === "rate1" ? 1 : 8);
      if (state === "unsupported") f.mesh.bindMode = "detached";
      const batch = new SkinnedBatch({
        first: f.mesh,
        capacity: 1,
        velocity: true,
        lookupLimits: limits,
      });
      try {
        f.player.update(1 / 60, true);
        if (state === "retained") draw(batch, f);
        f.track.values[1] = 1.5;
        f.joint.position.x = 0.9;
        draw(batch, f);
        expect(f.joint.position.x).toBeCloseTo(0.9);
        expectDisplayed(batch, f);
      } finally {
        batch.dispose();
        f.player.dispose();
      }
    },
  );

  it("draws independent phases, loop seams and variable/zero dt without evaluating skipped players", () => {
    const a = playback(8);
    const b = playback(8, a.clip);
    const exact = [playback(1, a.clip), playback(1, a.clip)] as const;
    b.player.mixer.clipAction(a.clip).time = 0.71;
    exact[1].player.mixer.clipAction(a.clip).time = 0.71;
    const batch = new SkinnedBatch({
      first: a.mesh,
      capacity: 2,
      velocity: true,
      lookupLimits: limits,
    });
    const updates = [vi.spyOn(a.player.mixer, "update"), vi.spyOn(b.player.mixer, "update")];
    try {
      for (let frame = 0; frame < 240; frame += 1) {
        const dt = [1 / 60, 0, 1 / 30, 1 / 120, 1 / 90][frame % 5] as number;
        batch.begin();
        for (const [index, f] of [a, b].entries()) {
          const reference = exact[index];
          const update = updates[index];
          assert(reference && update);
          f.player.update(dt);
          reference.player.update(dt);
          const before = update.mock.calls.length;
          const skipped = !f.player.updateRateReport.evaluated;
          f.root.position.x = reference.root.position.x = frame / 10 + index * 20;
          f.root.rotation.y = reference.root.rotation.y = frame / 100;
          f.root.scale.setScalar(1.2);
          reference.root.scale.setScalar(1.2);
          f.root.updateMatrixWorld(true);
          batch.write(batch.claim(f.mesh) as number, f.mesh);
          if (skipped) expect(update.mock.calls.length).toBe(before);
          expectDisplayed(batch, reference, index);
        }
        batch.end();
      }
    } finally {
      batch.dispose();
      for (const f of [a, b, ...exact]) f.player.dispose();
    }
  });

  it.each([
    "rest",
    "animated",
    "inverse",
    "values",
    "interpolation",
    "weight",
    "time",
    "attachment",
  ])(
    "falls back in the same write after pending %s mutation, preserving the displayed velocity pose",
    (mutation) => {
      const f = playback(8);
      const reference = playback(1);
      const batch = new SkinnedBatch({
        first: f.mesh,
        capacity: 1,
        velocity: true,
        lookupLimits: limits,
      });
      try {
        f.player.update(1 / 60);
        reference.player.update(1 / 60);
        draw(batch, f);
        do {
          f.player.update(1 / 60);
          reference.player.update(1 / 60);
          draw(batch, f);
        } while (f.player.updateRateReport.evaluated);
        const previous = batch.palette.slice();
        const pending =
          reference.player.mixer.clipAction(reference.clip).time -
          f.player.mixer.clipAction(f.clip).time;
        for (const target of [f, reference]) {
          const action = target.player.mixer.clipAction(target.clip);
          if (mutation === "rest") target.base.position.y = 0.25;
          if (mutation === "animated") target.joint.position.x = 0.9;
          if (mutation === "inverse") target.inverse.elements[13] = 0.5;
          if (mutation === "values") target.track.values[1] = 2;
          if (mutation === "interpolation") target.track.setInterpolation(InterpolateDiscrete);
          if (mutation === "weight") action.setEffectiveWeight(0.5);
          if (mutation === "time") action.time = 0.4 + (target === reference ? pending : 0);
          if (mutation === "attachment") target.joint.add(new Group());
        }
        // Public time edits apply to the already evaluated clock; pending ticks must be flushed first.
        reference.player.update(0, true);
        draw(batch, f);
        expectDisplayed(batch, reference);
        expect(f.player.updateRateReport.rate).toBe(1);
        expect([...(batch.history as Float32Array)]).toEqual([...previous]);
        if (mutation === "animated") {
          draw(batch, f);
          expectDisplayed(batch, reference);
          f.player.update(0);
          reference.player.update(0);
          draw(batch, f);
          expectDisplayed(batch, reference);
        }
      } finally {
        batch.dispose();
        f.player.dispose();
        reference.player.dispose();
      }
    },
  );

  it.each(["partial", "root", "attachment", "bind", "bytes", "bindings", "unknown"])(
    "uses current exact evaluation for %s ineligible rigs without baking",
    (reason) => {
      const f = playback(8);
      const reference = playback(1);
      for (const target of [f, reference]) {
        if (reason === "partial")
          target.mesh.skeleton = new Skeleton([target.joint], [target.inverse]);
        if (reason === "root") target.track.name = ".position[x]";
        if (reason === "attachment") target.joint.add(new Group());
        if (reason === "bind") target.mesh.bindMatrix.makeTranslation(0, 0.1, 0);
      }
      const batch = new SkinnedBatch({
        first: f.mesh,
        capacity: 1,
        velocity: true,
        lookupLimits:
          reason === "unknown"
            ? undefined
            : {
                ...limits,
                maxStorageBufferBindingSize:
                  reason === "bytes" ? 256 : limits.maxStorageBufferBindingSize,
                maxStorageBuffersPerShaderStage: reason === "bindings" ? 4 : 8,
              },
      });
      const bake = vi.spyOn(AnimationMixer.prototype, "setTime");
      try {
        for (let frame = 0; frame < 4; frame += 1) {
          f.player.update(1 / 60);
          reference.player.update(1 / 60);
          bake.mockClear();
          draw(batch, f);
          expectDisplayed(batch, reference);
          expect(f.player.updateRateReport.rate).toBe(1);
          expect(bake).not.toHaveBeenCalled();
        }
      } finally {
        bake.mockRestore();
        batch.dispose();
        f.player.dispose();
        reference.player.dispose();
      }
    },
  );

  it.each(["blend", "extra", "additive", "listener", "paused", "speed"])(
    "keeps public %s playback exact while time is pending",
    (reason) => {
      const f = playback(8);
      const reference = playback(1);
      const batch = new SkinnedBatch({
        first: f.mesh,
        capacity: 1,
        velocity: true,
        lookupLimits: limits,
      });
      try {
        for (let frame = 0; frame < 3; frame += 1) {
          f.player.update(1 / 60);
          reference.player.update(1 / 60);
          draw(batch, f);
        }
        for (const target of [f, reference]) {
          const action = target.player.mixer.clipAction(target.clip);
          if (reason === "blend") action.setEffectiveWeight(0.5);
          if (reason === "extra")
            target.player.mixer
              .clipAction(
                new AnimationClip("extra", 2, [
                  new NumberKeyframeTrack("joint.position[y]", [0, 2], [1, 2]),
                ]),
              )
              .play();
          if (reason === "additive") action.blendMode = AdditiveAnimationBlendMode;
          if (reason === "listener") target.player.mixer.addEventListener("loop", () => {});
          if (reason === "paused") action.paused = true;
          if (reason === "speed") action.setEffectiveTimeScale(-1);
        }
        reference.player.update(0, true);
        draw(batch, f);
        expectDisplayed(batch, reference);
        expect(f.player.updateRateReport.rate).toBe(1);
      } finally {
        batch.dispose();
        f.player.dispose();
        reference.player.dispose();
      }
    },
  );

  it("bakes compatible users once and releases shared storage only after the last batch/history owner", () => {
    const a = playback(8);
    const b = playback(8, a.clip);
    a.player.update(1 / 60);
    b.player.update(1 / 60);
    const batches = [a, b].map(
      (f) => new SkinnedBatch({ first: f.mesh, capacity: 1, velocity: true, lookupLimits: limits }),
    );
    const [first, second] = batches;
    assert(first && second);
    const bake = vi.spyOn(AnimationMixer.prototype, "setTime");
    const dispose = vi.spyOn(StorageBufferAttribute.prototype, "dispose");
    try {
      draw(first, a);
      draw(second, b);
      expect(bake).toHaveBeenCalledTimes(121);
      first.release(a.mesh);
      first.begin();
      first.end();
      expect(
        dispose.mock.contexts.filter(
          (attribute) =>
            attribute instanceof StorageBufferAttribute &&
            attribute.array.byteLength === 121 * 2 * 64,
        ),
      ).toHaveLength(0);
      b.player.update(1 / 60);
      draw(second, b);
      second.release(b.mesh);
      second.begin();
      second.end();
      expect(
        dispose.mock.contexts.filter(
          (attribute) =>
            attribute instanceof StorageBufferAttribute &&
            attribute.array.byteLength === 121 * 2 * 64,
        ),
      ).toHaveLength(1);
    } finally {
      for (const batch of batches) batch.dispose();
      a.player.dispose();
      b.player.dispose();
      bake.mockRestore();
      dispose.mockRestore();
    }
  });

  it("preserves lookup/exact history and resets a reused slot to its new owner's displayed pose", () => {
    const f = playback(8);
    const reference = playback(1, f.clip);
    const replacement = playback(8, f.clip);
    replacement.player.mixer.clipAction(f.clip).time = 0.73;
    const batch = new SkinnedBatch({
      first: f.mesh,
      capacity: 1,
      velocity: true,
      lookupLimits: limits,
    });
    try {
      for (const rate of [8, 1, 8, 1, 8]) {
        const previous = batch.palette.slice();
        f.player.updateRate = rate;
        f.player.update(1 / 60);
        reference.player.update(1 / 60);
        draw(batch, f);
        expectDisplayed(batch, reference);
        if (rate === 1) expect([...(batch.history as Float32Array)]).toEqual([...previous]);
      }
      batch.release(f.mesh);
      replacement.player.update(1 / 60);
      draw(batch, replacement);
      expect([...(batch.history as Float32Array)]).toEqual([...batch.palette]);
      expect(batch.palette[28]).toBeCloseTo(0.73 + 1 / 60, 5);
    } finally {
      batch.dispose();
      for (const target of [f, reference, replacement]) target.player.dispose();
    }
  });
});

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
      assert(reference.mesh.skeleton.boneMatrices);
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
    other.track.setInterpolation(InterpolateSmooth);
    expect(preparePoseBasis(other.root, other.mesh, other.clip)).toBeUndefined();
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
