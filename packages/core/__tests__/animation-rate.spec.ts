import {
  AnimationClip,
  Bone,
  Group,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  VectorKeyframeTrack,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationComposer } from "../src/animation-composition.js";
import { AnimationPlayer } from "../src/animation.js";
import { RenderCameraCull } from "../src/render-camera-cull.js";
import { SkeletalMesh3D } from "../src/skeletal-mesh.js";

function player(updateRate: "auto" | number = "auto") {
  const root = new Group();
  const clips = [1, 2, 3].map(
    (value) =>
      new AnimationClip(`clip${value}`, 1, [
        new NumberKeyframeTrack(".rotation[x]", [0, 1], [0, value]),
      ]),
  );
  const result = new AnimationPlayer({ root, clips, strideSync: false, updateRate });
  result.play("clip1");
  return result;
}

function rendered(result: AnimationPlayer, z = -100) {
  const mesh = new Mesh(new SphereGeometry(1, 8, 6), new MeshBasicMaterial());
  result.root.add(mesh);
  result.root.position.z = z;
  const scene = new Scene();
  scene.add(result.root);
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  const cull = new RenderCameraCull();
  const render = () => {
    scene.updateMatrixWorld(true);
    cull.apply(scene, camera, 720);
    cull.restore();
  };
  render();
  return { scene, camera, cull, render };
}

describe("AnimationPlayer update rate", () => {
  it.each([2, 4, 8])("accumulates clip time for 300 frames at rate %i", (rate) => {
    const baseline = player(1);
    const candidate = player(rate);
    const updates = vi.spyOn(candidate.mixer, "update");
    for (let frame = 0; frame < 300; frame += 1) {
      baseline.update(1 / 60);
      candidate.update(1 / 60, frame === 299);
      if (candidate.updateRateReport.evaluated) {
        expect(candidate.mixer.time).toBeCloseTo(baseline.mixer.time, 10);
        expect(candidate.mixer.clipAction(candidate.clip("clip1")).time).toBeCloseTo(
          baseline.mixer.clipAction(baseline.clip("clip1")).time,
          10,
        );
        expect(candidate.root.rotation.x).toBeCloseTo(baseline.root.rotation.x, 6);
      }
    }
    expect(updates.mock.calls.length).toBeLessThan(300 / rate + 2);
    expect(candidate.mixer.time).toBeCloseTo(5, 10);
    expect(candidate.updateRateReport).toMatchObject({ rate, overridden: true });
    baseline.dispose();
    candidate.dispose();
  });

  it("keeps crossfade weights and interrupted transitions exact over 300 frames", () => {
    const baseline = player(1);
    const candidate = player(8);
    for (let frame = 0; frame < 300; frame += 1) {
      if (frame === 37 || frame === 52) {
        const clip = frame === 37 ? "clip2" : "clip3";
        baseline.play(clip, { fade: 0.5 });
        candidate.play(clip, { fade: 0.5 });
      }
      baseline.update(1 / 60);
      candidate.update(1 / 60, frame === 299);
      for (const name of ["clip1", "clip2", "clip3"]) {
        const actual = candidate.mixer.clipAction(candidate.clip(name));
        const expected = baseline.mixer.clipAction(baseline.clip(name));
        expect(actual.getEffectiveWeight()).toBeCloseTo(expected.getEffectiveWeight(), 10);
        if (candidate.updateRateReport.evaluated)
          expect(actual.time).toBeCloseTo(expected.time, 10);
      }
    }
    baseline.dispose();
    candidate.dispose();
  });

  it("delivers finished on the same frame as rate 1, including replay", () => {
    const baseline = player(1);
    const candidate = player(8);
    const expected: number[] = [];
    const actual: number[] = [];
    let frame = 0;
    baseline.mixer.addEventListener("finished", () => expected.push(frame));
    candidate.mixer.addEventListener("finished", () => actual.push(frame));
    for (; frame < 300; frame += 1) {
      if (frame === 7 || frame === 177) {
        baseline.play("clip1", { mode: "once" });
        candidate.play("clip1", { mode: "once" });
      }
      baseline.update(1 / 60);
      candidate.update(1 / 60);
      expect(candidate.finished).toBe(baseline.finished);
      if (frame >= 7) expect(candidate.advancedFrames).toBe(baseline.advancedFrames);
    }
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(2);
    baseline.dispose();
    candidate.dispose();
  });

  it("preserves loop listener timing at a requested reduced rate", () => {
    const clip = new AnimationClip("loop", 0.05, [
      new NumberKeyframeTrack(".rotation[x]", [0, 0.05], [0, 1]),
    ]);
    const baseline = new AnimationPlayer({
      root: new Group(),
      clips: [clip],
      strideSync: false,
      updateRate: 1,
    });
    const candidate = new AnimationPlayer({
      root: new Group(),
      clips: [clip],
      strideSync: false,
      updateRate: 8,
    });
    baseline.play("loop");
    candidate.play("loop");
    const expected: { frame: number; loopDelta: number; clip: string }[] = [];
    const actual: { frame: number; loopDelta: number; clip: string }[] = [];
    let frame = 0;
    baseline.mixer.addEventListener("loop", ({ action, loopDelta }) =>
      expected.push({ frame, loopDelta, clip: action.getClip().name }),
    );
    candidate.mixer.addEventListener("loop", ({ action, loopDelta }) =>
      actual.push({ frame, loopDelta, clip: action.getClip().name }),
    );
    for (; frame < 60; frame += 1) {
      baseline.update(1 / 60);
      candidate.update(1 / 60);
    }
    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
    baseline.dispose();
    candidate.dispose();
  });

  it("flushes elapsed time before weighted phase sync and keeps transition weights exact", () => {
    const baseline = player(1);
    const candidate = player(8);
    for (let frame = 0; frame < 300; frame += 1) {
      if (frame === 19 || frame === 41) {
        const entries = [
          { clip: "clip2", weight: 0.6 },
          { clip: "clip3", weight: 0.4 },
        ];
        baseline.playWeighted(entries, { transition: 0.5 });
        candidate.playWeighted(entries, { transition: 0.5 });
      }
      baseline.update(1 / 60);
      candidate.update(1 / 60, frame === 299);
      for (const name of ["clip1", "clip2", "clip3"]) {
        const actual = candidate.mixer.clipAction(candidate.clip(name));
        const expected = baseline.mixer.clipAction(baseline.clip(name));
        expect(actual.getEffectiveWeight()).toBeCloseTo(expected.getEffectiveWeight(), 10);
        if (candidate.updateRateReport.evaluated)
          expect(actual.time).toBeCloseTo(expected.time, 10);
      }
    }
    baseline.dispose();
    candidate.dispose();
  });

  it.each([4, 8])("spreads 128 players within 1.5 times the mean at rate %i", (rate) => {
    const crowd = Array.from({ length: 128 }, () => player(rate));
    const counts: number[] = [];
    for (let frame = 0; frame < 300; frame += 1) {
      let count = 0;
      for (const rig of crowd) {
        rig.update(1 / 60);
        if (rig.updateRateReport.evaluated) count += 1;
      }
      counts.push(count);
    }
    const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length;
    expect(mean).toBe(128 / rate);
    expect(Math.max(...counts)).toBeLessThanOrEqual(mean * 1.5);
    for (const rig of crowd) rig.dispose();
  });

  it("forces evaluation before a changing stagger can exceed its rate", () => {
    const rig = player(8);
    let skipped = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      rig.updateRate = frame % 3 === 0 ? 2 : 8;
      rig.update(1 / 60);
      skipped = rig.updateRateReport.evaluated ? 0 : skipped + 1;
      expect(skipped).toBeLessThan(rig.updateRateReport.rate);
    }
    rig.update(0, true);
    expect(rig.updateRateReport.evaluated).toBe(true);
    expect(rig.mixer.time).toBeCloseTo(100 / 60, 10);
    rig.dispose();
  });

  it("never skips updateRate 1 and reports the explicit override", () => {
    const rig = player(1);
    for (let frame = 0; frame < 300; frame += 1) {
      rig.update(1 / 60);
      expect(rig.mixer.time).toBeCloseTo((frame + 1) / 60, 10);
      expect(rig.updateRateReport).toEqual({ rate: 1, overridden: true, evaluated: true });
    }
    rig.dispose();
  });

  it("measures auto rate from the render camera and keeps hidden rigs advancing", () => {
    const rig = player();
    expect(rig.updateRate).toBe("auto");
    const view = rendered(rig, -10);
    // Keep this policy subject off the centre ray: this test measures projected size, not camera
    // target recognition.
    rig.root.position.x = 2;
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport).toMatchObject({ rate: 1, overridden: false });
    rig.root.position.z = -100;
    view.render();
    const updates = vi.spyOn(rig.mixer, "update");
    for (let frame = 0; frame < 32; frame += 1) rig.update(1 / 60);
    expect(rig.updateRateReport.rate).toBeGreaterThan(1);
    expect(updates.mock.calls.length).toBeLessThan(32);
    rig.root.visible = false;
    view.render();
    for (let frame = 0; frame < 16; frame += 1) rig.update(1 / 60);
    expect(rig.updateRateReport.rate).toBeGreaterThanOrEqual(4);
    rig.update(0, true);
    expect(rig.mixer.time).toBeCloseTo(49 / 60, 10);
    rig.root.visible = true;
    rig.root.position.z = -10;
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport.rate).toBe(1);
    view.cull.dispose();
    rig.dispose();
  });

  it("keeps a distant unparented camera target at full rate and retargeting drops promotion", () => {
    const rig = player();
    const view = rendered(rig, -120);
    view.camera.lookAt(rig.root.position);
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport).toMatchObject({ rate: 1, overridden: false });

    view.camera.lookAt(10, 0, -120);
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport).toMatchObject({ rate: 4, overridden: false });

    view.cull.dispose();
    rig.dispose();
  });

  it("keeps root-motion composers evaluating and moving on every tick", () => {
    const body = new Group();
    const root = new Group();
    const hips = new Bone();
    hips.name = "Hips";
    body.add(root);
    root.add(hips);
    const clip = new AnimationClip("walk", 1, [
      new VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 0, 1]),
    ]);
    const composer = new AnimationComposer({
      root,
      clips: [clip],
      samples: ["walk"],
      rootMotion: { bone: "Hips", body },
    });
    const updates = vi.spyOn(composer.mixer, "update");
    for (let frame = 0; frame < 300; frame += 1) {
      const proposal = composer.advance(1 / 60);
      expect(proposal.translation.z).toBeCloseTo(1 / 60, 6);
      body.position.add(proposal.translation);
      composer.finish(proposal);
      expect(updates.mock.calls.length).toBe(frame + 1);
      expect(hips.position.z).toBe(0);
    }
    expect(body.position.z).toBeCloseTo(5, 6);
    composer.dispose();
  });

  it("returns a previously distant rig to full rate when attached to the render camera", () => {
    const rig = player();
    const view = rendered(rig);
    rig.root.position.x = 10;
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport.rate).toBeGreaterThan(1);
    view.scene.add(view.camera);
    view.camera.add(rig.root);
    view.render();
    rig.update(1 / 60);
    expect(rig.updateRateReport).toMatchObject({ rate: 1, evaluated: true });
    view.cull.dispose();
    rig.dispose();
  });

  it("passes the named override through SkeletalMesh3D", () => {
    const rig = new SkeletalMesh3D({ source: new Group(), updateRate: 4 });
    expect(rig.updateRate).toBe(4);
    rig.dispose();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid updateRate %s at construction and assignment",
    (rate) => {
      expect(() => player(rate)).toThrow(/updateRate/);
      const rig = player(1);
      expect(() => {
        rig.updateRate = rate;
      }).toThrow(/updateRate/);
      expect(rig.updateRate).toBe(1);
      rig.dispose();
    },
  );

  it("discards pending time on stop so a new clip receives only its own elapsed time", () => {
    const rig = player(8);
    rig.update(0.01);
    rig.stop();
    rig.play("clip2");
    rig.update(0.1, true);
    expect(rig.mixer.clipAction(rig.clip("clip2")).time).toBeCloseTo(0.1, 10);
    rig.dispose();
  });

  it("integrates changing stride rates without applying the last rate to skipped time", () => {
    const create = (updateRate: number) => {
      const body = new Group();
      const root = new Group();
      body.add(root);
      const clip = new AnimationClip("walk", 2, [
        new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
      ]);
      const rig = new AnimationPlayer({ root, clips: [clip], strideRoot: body, updateRate });
      rig.play("walk");
      return { rig, body, clip };
    };
    const baseline = create(1);
    const candidate = create(8);
    for (let frame = 0; frame < 300; frame += 1) {
      const distance = ((frame % 3) + 1) / 60;
      baseline.body.position.z += distance;
      candidate.body.position.z += distance;
      baseline.rig.update(1 / 60);
      candidate.rig.update(1 / 60, frame === 299);
      expect(candidate.rig.stride.rate).toBeCloseTo(baseline.rig.stride.rate, 8);
      if (candidate.rig.updateRateReport.evaluated)
        expect(candidate.rig.mixer.clipAction(candidate.clip).time).toBeCloseTo(
          baseline.rig.mixer.clipAction(baseline.clip).time,
          8,
        );
    }
    baseline.rig.dispose();
    candidate.rig.dispose();
  });

  it("retains elapsed playback when an action pauses during a skipped interval", () => {
    const baseline = player(1);
    const candidate = player(8);
    const expected = baseline.mixer.clipAction(baseline.clip("clip1"));
    const actual = candidate.mixer.clipAction(candidate.clip("clip1"));
    for (let frame = 0; frame < 300; frame += 1) {
      expected.paused = actual.paused = frame % 8 >= 3;
      baseline.update(1 / 60);
      candidate.update(1 / 60, frame === 299);
      if (candidate.updateRateReport.evaluated) expect(actual.time).toBeCloseTo(expected.time, 8);
    }
    baseline.dispose();
    candidate.dispose();
  });

  it("flushes a weighted loop before handing its current clip back to single playback", () => {
    const baseline = player(1);
    const candidate = player(1024);
    const entries = [
      { clip: "clip1", weight: 0.6 },
      { clip: "clip2", weight: 0.4 },
    ];
    baseline.playWeighted(entries);
    candidate.playWeighted(entries);
    for (let frame = 0; frame < 3; frame += 1) {
      baseline.update(1 / 60);
      candidate.update(1 / 60);
    }
    baseline.play("clip1", { fade: 0.2 });
    candidate.play("clip1", { fade: 0.2 });
    baseline.update(1 / 60);
    candidate.update(1 / 60);
    expect(candidate.mixer.clipAction(candidate.clip("clip1")).time).toBeCloseTo(
      baseline.mixer.clipAction(baseline.clip("clip1")).time,
      10,
    );
    baseline.dispose();
    candidate.dispose();
  });

  it.each([2, 4, 8])("spreads 128 rigs at rate %i so no frame exceeds 1.5x the mean", (rate) => {
    const rigs = Array.from({ length: 128 }, () => player(rate));
    const counts: number[] = [];
    for (let frame = 0; frame < 240; frame += 1) {
      let evaluated = 0;
      for (const rig of rigs) {
        rig.update(1 / 60);
        if (rig.updateRateReport.evaluated) evaluated += 1;
      }
      counts.push(evaluated);
    }
    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    expect(mean).toBeCloseTo(128 / rate, 5);
    expect(Math.max(...counts)).toBeLessThanOrEqual(1.5 * mean);
    for (const rig of rigs) rig.dispose();
  });
});
