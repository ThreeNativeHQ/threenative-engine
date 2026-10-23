import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Skeleton,
  SkinnedMesh,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateAnimationPoseFallback,
  evaluateAnimationPosePacket,
  readAnimationPosePacket,
  readAnimationPosePacketTime,
  refreshAnimationPosePacket,
} from "../src/animation-pose-packet.js";
import { AnimationPlayer } from "../src/animation.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture or eligible packet");
  return value;
}

function fixture() {
  const bones = Array.from({ length: 12 }, (_, i) => {
    const bone = new Bone();
    bone.name = `bone${i}`;
    bone.position.y = i ? 2 / 11 : -1;
    return bone;
  });
  bones.forEach((bone, i) => {
    if (i) bones[i - 1]?.add(bone);
  });
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.add(required(bones[0]));
  mesh.bind(new Skeleton(bones));
  const clip = new AnimationClip(
    "sway",
    2,
    Array.from(
      { length: 11 },
      (_, i) =>
        new NumberKeyframeTrack(`bone${i + 1}.rotation[z]`, [0, 1, 2], [-0.09, 0.09, -0.09]),
    ),
  );
  const player = new AnimationPlayer({
    root: mesh,
    clips: [clip],
    strideSync: false,
    updateRate: 8,
  });
  player.play("sway");
  player.update(0, true);
  mesh.updateMatrixWorld(true);
  return { mesh, bones, clip, player, action: player.mixer.clipAction(clip) };
}

describe("owned scalar-Z pose packets", () => {
  it("keeps refreshed fallback matrices at the latest CPU pose without changing prior history", () => {
    const f = fixture();
    try {
      const first = required(readAnimationPosePacket(f.mesh));
      const previous = evaluateAnimationPoseFallback(first.version);
      f.player.update(0.5, true);
      f.mesh.updateMatrixWorld(true);
      f.mesh.skeleton.update();
      const refreshed = required(refreshAnimationPosePacket(f.mesh, first.version));
      expect(evaluateAnimationPoseFallback(refreshed.version)).toEqual(
        f.mesh.skeleton.boneMatrices,
      );
      expect(evaluateAnimationPoseFallback(first.version)).toEqual(previous);
      expect(refreshed.version.keys).toBe(first.version.keys);
    } finally {
      f.player.dispose();
    }
  });

  it("captures the frozen chain and queries held logical time without author evaluation", () => {
    const f = fixture();
    const first = readAnimationPosePacket(f.mesh);
    expect(first?.version.parent).toEqual(Array.from({ length: 12 }, (_, i) => i - 1));
    expect(Object.keys(required(first).version.keys)).toHaveLength(11);
    const evaluate = vi.spyOn(f.player.mixer, "update");
    let held = false;
    for (let i = 0; i < 8; i++) {
      f.player.update(1 / 60);
      f.mesh.updateMatrixWorld(true);
      evaluate.mockClear();
      const packet = readAnimationPosePacket(f.mesh);
      expect(packet).toBeDefined();
      expect(evaluate).not.toHaveBeenCalled();
      if (!f.player.updateRateReport.evaluated) {
        held = true;
        expect(required(packet).time).toBeGreaterThan(f.action.time);
        break;
      }
    }
    expect(held).toBe(true);
    f.player.dispose();
  });

  it("owns immutable matrices/keys and rebuilds changed effective source data", () => {
    const f = fixture();
    const first = required(readAnimationPosePacket(f.mesh));
    const saved = JSON.stringify(first.version);
    expect(readAnimationPosePacket(f.mesh)?.version).toBe(first.version);
    required(f.clip.tracks[0]).values[2] = 0.2;
    const second = required(readAnimationPosePacket(f.mesh));
    expect(second.version).not.toBe(first.version);
    expect(required(second.version.keys[1]).values[2]).toBeCloseTo(0.2);
    f.mesh.position.x += 0.125;
    f.mesh.updateMatrixWorld(true);
    const third = required(readAnimationPosePacket(f.mesh));
    expect(third.version.rootWorld[12]).toBeCloseTo(0.125);
    expect(JSON.stringify(first.version)).toBe(saved);
    expect(Object.isFrozen(required(first.version.keys[1]).values)).toBe(true);
    expect(Object.isFrozen(required(first.version.rest[0]).local)).toBe(true);
    f.player.dispose();
  });

  it("refuses replaced track storage and track identities until genuinely rebound", () => {
    const f = fixture();
    expect(readAnimationPosePacket(f.mesh)).toBeDefined();
    required(f.clip.tracks[0]).values = required(f.clip.tracks[0]).values.slice();
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.player.dispose();
  });

  it("refuses custom interpolants without invoking them", () => {
    const f = fixture();
    const interpolants = Reflect.get(f.action, "_interpolants");
    const author = vi.fn(() => {
      throw new Error("author");
    });
    interpolants[0].interpolate_ = author;
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    expect(author).not.toHaveBeenCalled();
    f.player.dispose();
  });

  it("rejects an interpolant method replacement at the next full read without author calls", () => {
    const f = fixture();
    do {
      f.player.update(1 / 60);
      f.mesh.updateMatrixWorld(true);
    } while (f.player.updateRateReport.evaluated);
    const packet = required(readAnimationPosePacket(f.mesh));
    expect(readAnimationPosePacketTime(f.mesh, packet.version)).toBeDefined();
    const interpolants = Reflect.get(f.action, "_interpolants");
    const author = vi.fn(() => {
      throw new Error("held interpolant author");
    });
    interpolants[0].interpolate_ = author;
    // The held query trusts the capture; the batch repeats the full read every 256 evaluations.
    expect(readAnimationPosePacket(f.mesh) === undefined).toBe(true);
    expect(author).not.toHaveBeenCalled();
    f.player.dispose();
  });

  it("refuses nonidentity bind, unsupported root scale and changed topology", () => {
    const f = fixture();
    expect(readAnimationPosePacket(f.mesh)).toBeDefined();
    f.mesh.bindMatrix.elements[12] = 0.25;
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.mesh.bindMatrix.identity();
    f.mesh.scale.x = 2;
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.mesh.scale.x = 1;
    f.mesh.position.x = Number.MAX_VALUE;
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.mesh.position.x = 0;
    f.mesh.updateMatrixWorld(true);
    required(f.bones[0]).add(required(f.bones[2]));
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.player.dispose();
  });

  it("refuses authored matrix or pose edits and preserves old versions", () => {
    const f = fixture();
    const old = required(readAnimationPosePacket(f.mesh));
    const saved = JSON.stringify(old);
    required(f.bones[1]).rotation.z += 0.2;
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    expect(JSON.stringify(old)).toBe(saved);
    f.player.update(0.1, true);
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeDefined();
    required(f.bones[1]).matrix.elements[12] = 1;
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.player.dispose();
  });
  it("defers held numeric edits while owning old data, then validates the genuine refresh", () => {
    const f = fixture();
    const first = required(readAnimationPosePacket(f.mesh));
    f.player.update(1 / 60);
    f.mesh.updateMatrixWorld(true);
    while (f.player.updateRateReport.evaluated) {
      f.player.update(1 / 60);
      f.mesh.updateMatrixWorld(true);
    }
    required(f.clip.tracks[0]).values[2] = 0.2;
    f.mesh.bindMatrix.elements[12] = 0.5;
    const held = required(readAnimationPosePacketTime(f.mesh, first.version));
    expect(held.version).toBe(first.version);
    expect(required(held.version.keys[1]).values[2]).toBeCloseTo(-0.09);
    f.player.update(0.1, true);
    f.mesh.updateMatrixWorld(true);
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    f.mesh.bindMatrix.identity();
    const next = required(readAnimationPosePacket(f.mesh));
    expect(next.version).not.toBe(first.version);
    expect(required(next.version.keys[1]).values[2]).toBeCloseTo(0.2);
    f.player.dispose();
  });

  it("rejects held owner/duration/custom-update changes without author callbacks", () => {
    const f = fixture();
    const packet = required(readAnimationPosePacket(f.mesh));
    f.clip.duration = 3;
    expect(readAnimationPosePacketTime(f.mesh, packet.version)).toBeUndefined();
    f.clip.duration = 2;
    const author = vi.fn(() => {
      throw new Error("author update");
    });
    const original = f.mesh.skeleton.update;
    f.mesh.skeleton.update = author;
    expect(readAnimationPosePacketTime(f.mesh, packet.version)).toBeUndefined();
    expect(readAnimationPosePacket(f.mesh)).toBeUndefined();
    expect(author).not.toHaveBeenCalled();
    f.mesh.skeleton.update = original;
    f.player.dispose();
  });

  it("materializes cached CPU and saved displayed RAW poses independently", () => {
    const f = fixture();
    const reference = fixture();
    for (const fixture of [f, reference]) {
      fixture.mesh.position.set(1, 0.25, 3);
      fixture.mesh.rotation.y = 0.3;
      fixture.mesh.scale.setScalar(1.5);
      fixture.mesh.updateMatrixWorld(true);
    }
    const first = required(readAnimationPosePacket(f.mesh));
    f.mesh.skeleton.update();
    expect(Array.from(evaluateAnimationPoseFallback(first.version))).toEqual(
      Array.from(required(f.mesh.skeleton.boneMatrices)),
    );
    for (let i = 0; i < 8; i++) {
      f.player.update(1 / 60);
      f.mesh.updateMatrixWorld(true);
      if (!f.player.updateRateReport.evaluated) break;
    }
    const packet = required(readAnimationPosePacket(f.mesh));
    reference.player.update(packet.time, true);
    reference.mesh.updateMatrixWorld(true);
    reference.mesh.skeleton.update();
    const referenceMatrices = required(reference.mesh.skeleton.boneMatrices);
    const displayed = evaluateAnimationPosePacket(packet);
    const cached = evaluateAnimationPoseFallback(packet.version);
    expect(
      Math.max(...displayed.map((v, i) => Math.abs(v - (referenceMatrices[i] as number)))),
    ).toBeLessThan(2e-6);
    expect(
      Math.max(...displayed.map((v, i) => Math.abs(v - (cached[i] as number)))),
    ).toBeGreaterThan(1e-4);
    const saved = Array.from(displayed);
    f.player.update(0.3, true);
    f.mesh.updateMatrixWorld(true);
    readAnimationPosePacket(f.mesh);
    expect(Array.from(evaluateAnimationPosePacket(packet))).toEqual(saved);
    f.player.dispose();
    reference.player.dispose();
  });
});
