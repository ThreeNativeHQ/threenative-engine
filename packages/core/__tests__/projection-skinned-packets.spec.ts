import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Object3D,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import { describe, expect, it, vi } from "vitest";
import * as pose from "../src/animation-pose-packet.js";
import { AnimationPlayer } from "../src/animation.js";
import { SkinnedBatch } from "../src/projection-skinned.js";
import { RenderCameraCull, animationRateStates } from "../src/render-camera-cull.js";

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture value");
  return value;
}

function fixture(velocity = true, rate: 1 | 4 | "auto" = 4) {
  const scene = new Scene();
  const bones = Array.from({ length: 12 }, (_, i) => {
    const b = new Bone();
    b.name = `bone${i}`;
    b.position.y = i ? 2 / 11 : -1;
    return b;
  });
  bones.forEach((b, i) => {
    if (i) bones[i - 1]?.add(b);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0.1, 1, 0], 3));
  geometry.setAttribute("normal", new Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  geometry.setAttribute(
    "skinIndex",
    new Uint16BufferAttribute([0, 0, 0, 0, 5, 0, 0, 0, 11, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.add(present(bones[0]));
  mesh.bind(new Skeleton(bones));
  scene.add(mesh);
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
    updateRate: rate,
  });
  player.play("sway");
  player.update(0, true);
  scene.updateMatrixWorld(true);
  player.update(0);
  const batch = new SkinnedBatch({ first: mesh, capacity: 2, velocity });
  batch.claim(mesh);
  const tick = () => {
    player.update(1 / 60);
    scene.updateMatrixWorld(true);
  };
  const draw = () => {
    batch.begin();
    batch.write(0, mesh);
    batch.end();
  };
  const receipt = () => Reflect.get(batch.mesh.userData, "threenative.animationPosePackets")();
  const held = () => {
    for (let i = 0; i < 8; i++) {
      tick();
      draw();
      if (!present(animationRateStates.get(mesh)).evaluated) return;
    }
    throw Error("no held tick");
  };
  const close = () => {
    batch.dispose();
    player.dispose();
    geometry.dispose();
    mesh.material.dispose();
  };
  return {
    scene,
    mesh,
    bones,
    clip,
    player,
    batch,
    tick,
    draw,
    receipt,
    held,
    close,
    mixer: () => player.mixer,
  };
}

describe("SkinnedBatch owned scalar display packets", () => {
  it("submits independently saved current/previous RAW payloads on held ticks", () => {
    const f = fixture();
    try {
      f.draw();
      const first = f.receipt();
      expect(first.slots[0].currentRaw).toBe(true);
      f.held();
      const r = f.receipt();
      expect(r.slots[0].currentRaw).toBe(true);
      expect(r.slots[0].previousRaw).toBe(true);
      expect(r.slots[0].currentTime).toBeGreaterThan(r.slots[0].previousTime);
      expect(r.storage.meta).not.toBe(f.receipt().storage.meta);
      expect(r.instanceCount).toBe(1);
    } finally {
      f.close();
    }
  });
  it("matches stock first-update dedup across a second root refresh in one reconcile", () => {
    for (const [firstHeld, custom] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]) {
      const f = fixture();
      const stock = fixture();
      const stockUpdate = vi.spyOn(stock.mesh.skeleton, "update");
      try {
        if (firstHeld) {
          f.draw();
          stock.draw();
          for (let tick = 0; tick < 8; tick++) {
            f.player.update(0);
            stock.player.update(0);
            if (
              !present(animationRateStates.get(f.mesh)).evaluated &&
              !present(animationRateStates.get(stock.mesh)).evaluated
            )
              break;
            f.draw();
            stock.draw();
          }
        }
        const previousDisplay = firstHeld
          ? pose.evaluateAnimationPosePacket(
              present(
                pose.readAnimationPosePacketTime(
                  f.mesh,
                  present(pose.readAnimationPosePacket(f.mesh)).version,
                ),
              ),
            )
          : undefined;
        const stockCalls = stockUpdate.mock.calls.length;
        f.batch.begin();
        stock.batch.begin();
        f.batch.write(0, f.mesh);
        stock.batch.write(0, stock.mesh);
        expect(f.receipt().slots[0].currentRaw).toBe(true);
        expect(stockUpdate.mock.calls.length - stockCalls).toBe(firstHeld ? 0 : 1);
        const candidateUpdate = custom ? vi.spyOn(f.mesh.skeleton, "update") : undefined;
        f.mesh.position.x = stock.mesh.position.x = 1;
        f.scene.updateMatrixWorld(true);
        stock.scene.updateMatrixWorld(true);
        f.batch.write(0, f.mesh);
        stock.batch.write(0, stock.mesh);
        f.batch.end();
        stock.batch.end();
        if (candidateUpdate) expect(candidateUpdate).toHaveBeenCalledTimes(firstHeld ? 1 : 0);
        expect(stockUpdate.mock.calls.length - stockCalls).toBe(1);
        expect(f.mesh.skeleton.boneMatrices, `held=${firstHeld} custom=${custom}`).toEqual(
          stock.mesh.skeleton.boneMatrices,
        );
        expect(f.batch.palette).toEqual(stock.batch.palette);
        if (previousDisplay)
          expect(present(f.batch.history).subarray(0, 192)).toEqual(previousDisplay);
        else expect(f.batch.history).toEqual(stock.batch.history);
        expect(f.receipt().slots[0].currentRaw).toBe(false);
        candidateUpdate?.mockRestore();
      } finally {
        stockUpdate.mockRestore();
        f.close();
        stock.close();
      }
    }
  });
  it("keeps rate1 controls on genuine stock without capture/query", () => {
    const f = fixture(true, 1);
    const cull = new RenderCameraCull();
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.z = 40;
    camera.updateMatrixWorld(true);
    cull.apply(f.scene, camera, 720);
    cull.restore();
    expect(present(animationRateStates.get(f.mesh)).rate).toBeGreaterThan(1);
    const capture = vi.spyOn(pose, "readAnimationPosePacket");
    const query = vi.spyOn(pose, "readAnimationPosePacketTime");
    const update = vi.spyOn(f.mesh.skeleton, "update");
    try {
      f.tick();
      f.draw();
      expect(capture).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(f.receipt().slots[0].currentRaw).toBe(false);
    } finally {
      capture.mockRestore();
      query.mockRestore();
      update.mockRestore();
      cull.dispose();
      f.close();
    }
  });
  it("retires only the overridden owner while retaining saved previous RAW and held CPU cache", () => {
    const f = fixture();
    try {
      f.draw();
      f.held();
      const before = f.receipt();
      const saved = present(pose.readAnimationPosePacket(f.mesh));
      const update = vi.spyOn(f.mesh.skeleton, "update");
      f.batch.begin();
      f.batch.write(0, f.mesh);
      f.batch.end();
      const retired = f.receipt();
      expect(retired.slots[0].currentRaw).toBe(false);
      expect(retired.slots[0].previousRaw).toBe(true);
      expect(update).not.toHaveBeenCalled();
      expect(retired.slots[0].previousTime).toBe(before.slots[0].currentTime);
      expect(f.batch.palette.subarray(0, 192)).toEqual(
        pose.evaluateAnimationPoseFallback(saved.version),
      );
      expect(present(f.batch.history).subarray(0, 192)).toEqual(
        pose.evaluateAnimationPosePacket(saved),
      );
      f.mesh.position.x += 0.1;
      f.scene.updateMatrixWorld(true);
      f.draw();
      expect(update).toHaveBeenCalledTimes(1);
      update.mockRestore();
      f.draw();
      expect(f.receipt().slots[0].retired).toBe(true);
    } finally {
      f.close();
    }
  });
  it("advances a trusted held rig by its playhead alone, with no packet read or state build", () => {
    const f = fixture();
    try {
      f.draw();
      f.held();
      const before = f.receipt().slots[0];
      const query = vi.spyOn(pose, "readAnimationPosePacketTime");
      const capture = vi.spyOn(pose, "readAnimationPosePacket");
      const refresh = vi.spyOn(pose, "refreshAnimationPosePacket");
      try {
        const rate = present(animationRateStates.get(f.mesh));
        let ticks = 0;
        // Step to the next held tick; an evaluation in between takes the refresh path by design.
        do {
          f.tick();
          if (rate.evaluated) {
            f.draw();
            query.mockClear();
            capture.mockClear();
            refresh.mockClear();
          }
        } while (rate.evaluated && ++ticks < 8);
        expect(rate.evaluated).toBe(false);
        const reference = f.receipt().slots[0];
        f.draw();
        const after = f.receipt().slots[0];
        expect(after.currentRaw).toBe(true);
        expect(after.currentTime).toBeGreaterThan(reference.currentTime);
        expect(before.currentRaw).toBe(true);
        expect(query).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
        capture.mockRestore();
        refresh.mockRestore();
      }
    } finally {
      f.close();
    }
  });
  it("first public observation preserves actual mutable arrays and stock fresh/end semantics", () => {
    const f = fixture();
    try {
      f.batch.begin();
      f.batch.write(0, f.mesh);
      const update = vi.spyOn(f.mesh.skeleton, "update");
      const current = f.batch.palette;
      const previous = present(f.batch.history);
      expect(update).not.toHaveBeenCalled();
      expect(previous.every((v) => v === 0)).toBe(true);
      f.batch.end();
      expect(previous).toEqual(current);
      update.mockRestore();
      f.held();
      current[0] = 123;
      previous[0] = -42;
      expect(f.batch.palette[0]).toBe(123);
      expect(present(f.batch.history)[0]).toBe(-42);
      f.batch.begin();
      expect(previous[0]).toBe(123);
      f.batch.write(0, f.mesh);
      f.batch.end();
      expect(current[0]).toBe(123);
      expect(f.batch.palette).toBe(current);
      expect(f.batch.history).toBe(previous);
      f.batch.restart(0);
      f.batch.end();
      expect(previous).toEqual(current);
      f.batch.hide(0);
      expect(current.every((v) => v === 0)).toBe(true);
      expect(previous.every((v) => v === 0)).toBe(true);
    } finally {
      f.close();
    }
  });
  it("supports observation before any packet and optional absent history", () => {
    const f = fixture(false);
    try {
      expect(f.batch.history).toBeUndefined();
      const p = f.batch.palette;
      expect(p.every((v) => v === 0)).toBe(true);
      f.tick();
      f.draw();
      expect(f.batch.palette).toBe(p);
      expect(f.receipt().slots[0].currentRaw).toBe(true);
      expect(f.batch.history).toBeUndefined();
    } finally {
      f.close();
    }
  });
  it("late shared ownership retires the earlier RAW display and retains stock skeleton dedup", () => {
    const f = fixture();
    try {
      f.draw();
      f.held();
      const saved = present(pose.readAnimationPosePacket(f.mesh));
      const displayed = pose.evaluateAnimationPosePacket(saved);
      expect(displayed).not.toEqual(pose.evaluateAnimationPoseFallback(saved.version));
      const other = new SkinnedMesh(f.mesh.geometry, f.mesh.material);
      other.bind(f.mesh.skeleton);
      f.scene.add(other);
      f.scene.updateMatrixWorld(true);
      const update = vi.spyOn(f.mesh.skeleton, "update");
      expect(f.batch.claim(other)).toBe(1);
      expect(update).not.toHaveBeenCalled();
      f.batch.begin();
      f.batch.write(0, f.mesh);
      f.batch.write(1, other);
      f.batch.end();
      expect(f.receipt().slots.every((s: { currentRaw: boolean }) => !s.currentRaw)).toBe(true);
      expect(update).toHaveBeenCalledTimes(1);
      expect(f.receipt().slots[0].previousRaw).toBe(true);
      expect(present(f.batch.history).subarray(0, 192)).toEqual(displayed);
      expect(update).toHaveBeenCalledTimes(1);
      update.mockRestore();
      f.batch.release(other);
      expect(f.batch.claim(other)).toBe(1);
      f.draw();
      expect(f.receipt().slots[0].retired).toBe(true);
    } finally {
      f.close();
    }
  });
  it("revokes an already-written RAW owner when sharing is claimed during reconcile", () => {
    const f = fixture();
    try {
      f.draw();
      f.held();
      const saved = present(pose.readAnimationPosePacket(f.mesh));
      const previousDisplay = pose.evaluateAnimationPosePacket(saved);
      f.batch.begin();
      f.batch.write(0, f.mesh);
      expect(f.receipt().slots[0].currentRaw).toBe(true);
      const other = new SkinnedMesh(f.mesh.geometry, f.mesh.material);
      other.bind(f.mesh.skeleton);
      expect(f.batch.claim(other)).toBe(1);
      expect(f.receipt().slots[0].currentRaw).toBe(false);
      f.batch.write(1, other);
      f.batch.end();
      expect(f.receipt().slots.every((slot: { currentRaw: boolean }) => !slot.currentRaw)).toBe(
        true,
      );
      expect(present(f.batch.history).subarray(0, 192)).toEqual(previousDisplay);
    } finally {
      f.close();
    }
  });
  it("keeps a neighboring unique skeleton RAW when one owner retires", () => {
    const f = fixture();
    const neighbor = fixture();
    try {
      f.scene.add(neighbor.mesh);
      expect(f.batch.claim(neighbor.mesh)).toBe(1);
      f.scene.updateMatrixWorld(true);
      f.batch.begin();
      f.batch.write(0, f.mesh);
      f.batch.write(1, neighbor.mesh);
      f.batch.end();
      f.held();
      const update = vi.spyOn(f.mesh.skeleton, "update");
      f.batch.begin();
      f.batch.write(0, f.mesh);
      f.batch.write(1, neighbor.mesh);
      f.batch.end();
      expect(f.receipt().slots.map((s: { currentRaw: boolean }) => s.currentRaw)).toEqual([
        false,
        true,
      ]);
      expect(update).not.toHaveBeenCalled();
      update.mockRestore();
      f.batch.hide(0);
      f.draw();
      expect(f.receipt().slots[0].retired).toBe(true);
      expect(f.receipt().slots[1].currentRaw).toBe(true);
    } finally {
      f.close();
      neighbor.close();
    }
  });
  it("observes between begin/write and after restart without losing stock history boundaries", () => {
    for (const restart of [false, true]) {
      const f = fixture();
      try {
        f.draw();
        f.held();
        const saved = present(pose.readAnimationPosePacket(f.mesh));
        if (restart) f.batch.restart(0);
        else f.batch.begin();
        const update = vi.spyOn(f.mesh.skeleton, "update");
        const current = f.batch.palette;
        const previous = present(f.batch.history);
        expect(update).not.toHaveBeenCalled();
        expect(current.subarray(0, 192)).toEqual(pose.evaluateAnimationPosePacket(saved));
        if (!restart) expect(previous.subarray(0, 192)).toEqual(current.subarray(0, 192));
        f.batch.end();
        if (restart) expect(previous.subarray(0, 192)).toEqual(current.subarray(0, 192));
        expect(f.batch.palette).toBe(current);
        expect(f.batch.history).toBe(previous);
        update.mockRestore();
      } finally {
        f.close();
      }
    }
  });
  it("preserves previous STOCK storage on first nonfresh RAW promotion and observation", () => {
    const f = fixture();
    try {
      f.player.update(0, true);
      f.scene.updateMatrixWorld(true);
      f.draw();
      expect(f.receipt().slots[0].currentRaw).toBe(false);
      const stock = new Float32Array(present(f.mesh.skeleton.boneMatrices));
      for (let i = 0; i < 8; i++) {
        f.tick();
        if (present(animationRateStates.get(f.mesh)).evaluated) break;
      }
      f.draw();
      expect(f.receipt().slots[0].currentRaw).toBe(true);
      expect(f.receipt().slots[0].previousRaw).toBe(false);
      const raw = present(pose.readAnimationPosePacket(f.mesh));
      const update = vi.spyOn(f.mesh.skeleton, "update");
      const current = f.batch.palette;
      const previous = present(f.batch.history);
      expect(update).not.toHaveBeenCalled();
      expect(current.subarray(0, 192)).toEqual(pose.evaluateAnimationPosePacket(raw));
      expect(previous.subarray(0, 192)).toEqual(stock);
      update.mockRestore();
    } finally {
      f.close();
    }
  });
  it("marks actual materialized palette storage immediately without changing RAW modes after end", () => {
    const f = fixture();
    f.draw();
    const uploaded: BufferAttribute[] = [];
    const setter = present(
      present(Object.getOwnPropertyDescriptor(BufferAttribute.prototype, "needsUpdate")).set,
    );
    const mark = vi
      .spyOn(BufferAttribute.prototype, "needsUpdate", "set")
      .mockImplementation(function (this: BufferAttribute, value: boolean) {
        if (value) uploaded.push(this);
        setter.call(this, value);
      });
    try {
      const current = f.batch.palette;
      const previous = present(f.batch.history);
      expect(uploaded.filter((a) => a.array === current)).toHaveLength(1);
      expect(uploaded.filter((a) => a.array === previous)).toHaveLength(1);
      expect(uploaded).toHaveLength(2);
      expect(f.receipt().slots[0].currentRaw).toBe(true);
    } finally {
      mark.mockRestore();
      f.close();
    }
  });
  it("keeps RAW motion advancing after a read on a held CPU tick", () => {
    const f = fixture();
    try {
      f.draw();
      const current = f.batch.palette;
      const first = current.slice(0, 192);
      const time = f.receipt().slots[0].currentTime;
      f.held();
      expect(f.receipt().slots[0].currentRaw).toBe(true);
      expect(f.receipt().slots[0].currentTime).toBeGreaterThan(time);
      expect(f.batch.palette).toBe(current);
      expect(current.subarray(0, 192)).not.toEqual(first);
    } finally {
      f.close();
    }
  });
  it("detects observed edits at end and on a second getter without retiring the neighbor", () => {
    for (const boundary of ["end", "getter"]) {
      const f = fixture();
      const neighbor = fixture();
      try {
        f.scene.add(neighbor.mesh);
        f.batch.claim(neighbor.mesh);
        f.scene.updateMatrixWorld(true);
        f.batch.begin();
        f.batch.write(0, f.mesh);
        f.batch.write(1, neighbor.mesh);
        f.batch.end();
        f.held();
        f.batch.begin();
        f.batch.write(0, f.mesh);
        f.batch.write(1, neighbor.mesh);
        const current = f.batch.palette;
        const history = present(f.batch.history);
        current[0] = 77;
        if (boundary === "getter") expect(f.batch.palette[0]).toBe(77);
        f.batch.end();
        expect(f.receipt().slots.map((s: { currentRaw: boolean }) => s.currentRaw)).toEqual([
          false,
          true,
        ]);
        expect(current[0]).toBe(77);
        f.batch.begin();
        expect(history[0]).toBe(77);
        f.batch.write(0, f.mesh);
        f.batch.end();
        expect(current[0]).toBe(77);
      } finally {
        f.close();
        neighbor.close();
      }
    }
  });
  it("resumes RAW after a temporary forced full-rate stock frame", () => {
    const f = fixture();
    try {
      f.draw();
      expect(f.receipt().slots[0].currentRaw).toBe(true);
      f.player.update(0, true);
      f.scene.updateMatrixWorld(true);
      f.draw();
      expect(f.receipt().slots[0].currentRaw).toBe(false);
      expect(f.receipt().slots[0].previousRaw).toBe(true);
      expect(f.receipt().slots[0].retired).toBe(false);
      let resumed = false;
      for (let i = 0; i < 8; i++) {
        f.tick();
        f.draw();
        if (f.receipt().slots[0].currentRaw) {
          resumed = true;
          break;
        }
      }
      expect(resumed).toBe(true);
    } finally {
      f.close();
    }
  });

  describe("GPU-evaluated pose", () => {
    const sway = (t: number) => -0.09 + 0.18 * (t <= 1 ? t : 2 - t);
    function auto(distance = 40, rate: 1 | "auto" = "auto") {
      const f = fixture(true, rate);
      const cull = new RenderCameraCull();
      const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
      camera.position.z = distance;
      camera.updateMatrixWorld(true);
      const evaluations = vi.spyOn(f.mixer(), "update");
      const frame = () => {
        cull.apply(f.scene, camera, 720);
        f.tick();
        f.draw();
        cull.restore();
      };
      return {
        ...f,
        frame,
        evaluations,
        close: () => {
          evaluations.mockRestore();
          cull.dispose();
          f.close();
        },
      };
    }
    it("refreshes the CPU bones every rate x 4 ticks while the drawn playhead stays exact", () => {
      const f = auto();
      try {
        const rate = present(animationRateStates.get(f.mesh));
        f.frame();
        const base = f.evaluations.mock.calls.length;
        for (let i = 1; i <= 96; i++) {
          f.frame();
          expect(rate.gpuPose).toBe(true);
          const shown = f.receipt().slots[0].currentTime;
          expect(f.receipt().slots[0].currentRaw).toBe(true);
          expect(Math.abs(shown - (((i + 1) / 60) % 2))).toBeLessThan(1e-4);
        }
        const evaluated = f.evaluations.mock.calls.length - base;
        expect(rate.effectiveRate).toBeGreaterThan(1);
        expect(evaluated).toBeLessThanOrEqual(Math.ceil(96 / ((rate.effectiveRate ?? 1) * 4)) + 1);
        expect(f.player.updateRateReport.boneRate).toBe((rate.effectiveRate ?? 1) * 4);
      } finally {
        f.close();
      }
    });
    it("returns to the scheduled rate on the next tick once the GPU pose is dropped", () => {
      const f = auto();
      try {
        for (let i = 0; i < 12; i++) f.frame();
        const rate = present(animationRateStates.get(f.mesh));
        rate.gpuPose = false;
        let waited = 0;
        while (waited < 16) {
          f.frame();
          waited += 1;
          if (rate.evaluated) break;
        }
        expect(waited).toBeLessThanOrEqual(1);
      } finally {
        f.close();
      }
    });
    it("hands the bones back exact when the rig leaves the batch", () => {
      const f = auto();
      try {
        for (let i = 0; i < 13; i++) f.frame();
        const now = 13 / 60;
        expect(present(f.mesh.skeleton.bones[1]).rotation.z).not.toBeCloseTo(sway(now), 6);
        f.batch.release(f.mesh);
        expect(present(f.mesh.skeleton.bones[1]).rotation.z).toBeCloseTo(sway(now), 6);
        expect(present(animationRateStates.get(f.mesh)).gpuPose).toBe(false);
      } finally {
        f.close();
      }
    });
    it("keeps an explicit updateRate on its own interval", () => {
      const f = fixture(true, 4);
      try {
        f.draw();
        f.held();
        expect(f.player.updateRateReport.boneRate).toBe(4);
      } finally {
        f.close();
      }
    });

    describe("near rigs", () => {
      const near = (rate: 1 | "auto" = "auto") => auto(4, rate);
      /** Every bone's local pose and every child's world matrix match the playhead at `t`. */
      const exact = (f: ReturnType<typeof near>, t: number) => {
        for (const bone of f.bones.slice(1)) expect(bone.rotation.z).toBeCloseTo(sway(t % 2), 6);
        for (const bone of f.bones)
          for (const child of bone.children)
            if (!(child as Bone).isBone)
              expect(
                child.matrixWorld.equals(bone.matrixWorld.clone().multiply(child.matrix)),
              ).toBe(true);
      };

      /** Frames a near rig onto the GPU pose until its CPU bones lag the playhead; returns the frame. */
      const untilStale = (f: ReturnType<typeof near>) => {
        for (let i = 1; i <= 24; i++) {
          f.frame();
          if (i > 8 && Math.abs(present(f.bones[1]).rotation.z - sway((i / 60) % 2)) > 1e-6)
            return i;
        }
        throw Error("bones never lagged the GPU pose");
      };

      it("refreshes an unattached near rig's bones every 4th evaluation and draws the exact playhead", () => {
        const f = near();
        try {
          const rate = present(animationRateStates.get(f.mesh));
          f.frame();
          const base = f.evaluations.mock.calls.length;
          for (let i = 1; i <= 96; i++) {
            f.frame();
            expect(rate.effectiveRate).toBe(1);
            expect(rate.gpuPose).toBe(true);
            expect(f.receipt().slots[0].currentRaw).toBe(true);
            expect(Math.abs(f.receipt().slots[0].currentTime - (((i + 1) / 60) % 2))).toBeLessThan(
              1e-4,
            );
          }
          expect(f.evaluations.mock.calls.length - base).toBeLessThanOrEqual(Math.ceil(96 / 4) + 1);
          expect(f.player.updateRateReport.boneRate).toBe(4);
        } finally {
          f.close();
        }
      });

      it("keeps stock every-tick bones and an exact attachment for a near rig holding a child", () => {
        const f = near();
        const weapon = new Object3D();
        try {
          weapon.position.set(0.1, 0.2, 0);
          present(f.bones[11]).add(weapon);
          for (let i = 1; i <= 24; i++) {
            f.frame();
            expect(present(animationRateStates.get(f.mesh)).gpuPose).not.toBe(true);
            expect(f.receipt().slots[0].currentRaw).toBe(false);
            exact(f, i / 60);
          }
          expect(f.player.updateRateReport.boneRate).toBe(1);
        } finally {
          f.close();
        }
      });

      it("keeps a far rig holding a child on stock bones at its own rate", () => {
        const f = auto();
        try {
          present(f.bones[6]).add(new Scene());
          for (let i = 0; i < 24; i++) f.frame();
          const rate = present(animationRateStates.get(f.mesh));
          expect(rate.effectiveRate).toBeGreaterThan(1);
          expect(rate.gpuPose).toBe(false);
          expect(f.receipt().slots[0].currentRaw).toBe(false);
          expect(f.player.updateRateReport.boneRate).toBe(rate.effectiveRate);
        } finally {
          f.close();
        }
      });

      it("keeps a near rig on stock bones while its palette is observed", () => {
        const f = near();
        try {
          void f.batch.palette;
          for (let i = 1; i <= 12; i++) {
            f.frame();
            expect(present(animationRateStates.get(f.mesh)).gpuPose).not.toBe(true);
            exact(f, i / 60);
          }
        } finally {
          f.close();
        }
      });

      it("drops an observed near rig back to stock with exact bones on its next tick", () => {
        const f = near();
        try {
          const now = untilStale(f);
          expect(present(animationRateStates.get(f.mesh)).gpuPose).toBe(true);
          void f.batch.palette;
          for (let i = now + 1; i <= now + 7; i++) {
            f.frame();
            expect(present(animationRateStates.get(f.mesh)).gpuPose).toBe(false);
            exact(f, i / 60);
          }
        } finally {
          f.close();
        }
      });

      it("drops a near rig to stock with exact bones on the tick a child is attached", () => {
        const f = near();
        try {
          const now = untilStale(f);
          const rate = present(animationRateStates.get(f.mesh));
          expect(rate.gpuPose).toBe(true);
          present(f.bones[11]).add(new Object3D());
          for (let i = now + 1; i <= now + 17; i++) {
            f.frame();
            expect(rate.gpuPose).toBe(false);
            expect(f.receipt().slots[0].currentRaw).toBe(false);
            expect(f.receipt().slots[0].retired).toBe(true);
            exact(f, i / 60);
          }
        } finally {
          f.close();
        }
      });

      it("hands a near rig's bones back exact on release and on dispose", () => {
        for (const leave of ["release", "dispose"] as const) {
          const f = near();
          try {
            const now = untilStale(f);
            if (leave === "release") f.batch.release(f.mesh);
            else f.batch.dispose();
            exact(f, now / 60);
            const tip = present(f.bones[11]).matrixWorld.clone();
            f.scene.updateMatrixWorld(true);
            expect(present(f.bones[11]).matrixWorld.equals(tip)).toBe(true);
            expect(present(animationRateStates.get(f.mesh)).gpuPose).toBe(false);
          } finally {
            f.close();
          }
        }
      });

      it("keeps an explicit updateRate 1 near rig on stock every-tick bones", () => {
        const f = near(1);
        try {
          for (let i = 1; i <= 12; i++) {
            f.frame();
            expect(present(animationRateStates.get(f.mesh)).gpuPose).not.toBe(true);
            expect(f.receipt().slots[0].currentRaw).toBe(false);
            exact(f, i / 60);
          }
          expect(f.player.updateRateReport.boneRate).toBe(1);
        } finally {
          f.close();
        }
      });
    });
  });
});
