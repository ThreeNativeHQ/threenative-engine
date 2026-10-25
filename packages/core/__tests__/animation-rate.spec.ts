import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  LoopOnce,
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
import { RenderCameraCull, animationRateStates } from "../src/render-camera-cull.js";
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
  it("measures a report-only stride once per evaluation and reports the interval's average speed", () => {
    const fast = player(4);
    const stock = player(1);
    const walk = (rig: AnimationPlayer, ticks: number) => {
      const spy = vi.spyOn(rig.root, "getWorldPosition");
      for (let tick = 0; tick < ticks; tick++) {
        rig.root.position.x += 1 / 60;
        rig.update(1 / 60);
      }
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };
    walk(fast, 1);
    walk(stock, 1);
    // 16 ticks at rate 4 are four evaluations: the three held ticks between them bank their dt.
    expect(walk(stock, 16)).toBe(16);
    expect(walk(fast, 16)).toBe(4);
    expect(fast.stride.groundSpeed).toBeCloseTo(1, 5);
    expect(fast.stride.groundSpeed).toBeCloseTo(stock.stride.groundSpeed, 5);
  });
  it("records named rate1 independently of distant cull policy", () => {
    const rig = player(1);
    const view = rendered(rig, -120);
    view.camera.lookAt(10, 0, -120);
    view.render();
    rig.update(1 / 60);
    expect(animationRateStates.get(rig.root)?.rate).toBeGreaterThan(1);
    expect(animationRateStates.get(rig.root)?.effectiveRate).toBe(1);
    view.cull.dispose();
    rig.dispose();
  });

  it("records explicit cadence without cull and forces stock on forced evaluation", () => {
    const rig = player(4);
    rig.update(1 / 60);
    expect(animationRateStates.get(rig.root)?.rate).toBe(1);
    expect(animationRateStates.get(rig.root)?.effectiveRate).toBe(4);
    rig.update(1 / 60, true);
    expect(animationRateStates.get(rig.root)?.effectiveRate).toBe(1);
    expect(rig.updateRateReport.rate).toBe(4);
    rig.update(1 / 60);
    expect(animationRateStates.get(rig.root)?.effectiveRate).toBe(4);
    rig.dispose();
  });

  it.each([1, 8])("preserves public callback mixer state at requested rate %i", (rate) => {
    for (const event of ["loop", "finished"] as const) {
      const candidate = player(rate);
      const expected = new AnimationMixer(new Group());
      const expectedAction = expected.clipAction(candidate.clip("clip1")).play();
      const actualAction = candidate.mixer.clipAction(candidate.clip("clip1"));
      if (event === "finished") {
        expectedAction.setLoop(LoopOnce, 1);
        actualAction.setLoop(LoopOnce, 1);
        expectedAction.clampWhenFinished = actualAction.clampWhenFinished = true;
      }
      const reads: number[] = [];
      for (const mixer of [expected, candidate.mixer]) {
        mixer.timeScale = 2;
        mixer.addEventListener(event, () => {
          reads.push(mixer.timeScale);
          mixer.timeScale = 0;
        });
      }
      expected.update(0.5);
      candidate.update(0.5, true);
      expect(reads).toEqual([2, 2]);
      expect(candidate.mixer.timeScale).toBe(expected.timeScale);
      candidate.dispose();
    }
  });

  it.each([1, 8])("retains loop callback action speed at requested rate %i", (rate) => {
    const candidate = player(rate);
    const action = candidate.mixer.clipAction(candidate.clip("clip1"));
    candidate.mixer.addEventListener("loop", () => action.setEffectiveTimeScale(2));
    candidate.update(1, true);
    expect(action.timeScale).toBe(2);
    candidate.dispose();
  });

  it("protects public finished listeners without pinning unobserved loops", () => {
    const candidate = player(8);
    const listener = vi.fn();
    expect(candidate.updateRateReport.rate).toBe(8);
    candidate.mixer.addEventListener("finished", listener);
    expect(candidate.updateRateReport.rate).toBe(1);
    candidate.mixer.removeEventListener("finished", listener);
    expect(candidate.updateRateReport.rate).toBe(8);
    candidate.dispose();
  });

  it("flushes prior skipped time before a signed mixer speed change", () => {
    const candidate = player(8);
    const expected = new AnimationMixer(new Group());
    const expectedAction = expected.clipAction(candidate.clip("clip1")).play();
    do {
      expected.update(0.1);
      candidate.update(0.1);
    } while (candidate.updateRateReport.evaluated);
    expected.timeScale = candidate.mixer.timeScale = -1;
    expectedAction.setEffectiveTimeScale(2);
    candidate.mixer.clipAction(candidate.clip("clip1")).setEffectiveTimeScale(2);
    expected.update(0.1);
    candidate.update(0.1, true);
    expect(candidate.mixer.time).toBeCloseTo(expected.time, 10);
    expect(candidate.mixer.clipAction(candidate.clip("clip1")).time).toBeCloseTo(
      expectedAction.time,
      10,
    );
    candidate.dispose();
  });

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

  it("starts a newly registered loop listener after skipped time", () => {
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
    for (let frame = 0; frame < 6; frame += 1) {
      baseline.update(1 / 60);
      candidate.update(1 / 60);
    }
    const expected: { frame: number; loopDelta: number; clip: string }[] = [];
    const actual: { frame: number; loopDelta: number; clip: string }[] = [];
    let frame = 6;
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

  it("restores throttling after duplicate listener removal and later re-registration", () => {
    const clip = new AnimationClip("loop", 0.05, [
      new NumberKeyframeTrack(".rotation[x]", [0, 0.05], [0, 1]),
    ]);
    const candidate = new AnimationPlayer({
      root: new Group(),
      clips: [clip],
      strideSync: false,
      updateRate: 8,
    });
    candidate.play("loop");
    const first = vi.fn();
    const second = vi.fn();
    expect(candidate.updateRateReport.rate).toBe(8);
    candidate.mixer.addEventListener("loop", first);
    candidate.mixer.addEventListener("loop", first);
    expect(candidate.updateRateReport.rate).toBe(1);
    candidate.mixer.removeEventListener("loop", first);
    expect(candidate.updateRateReport.rate).toBe(8);
    candidate.mixer.addEventListener("loop", first);
    candidate.mixer.addEventListener("loop", second);
    candidate.mixer.removeEventListener("loop", first);
    expect(candidate.updateRateReport.rate).toBe(1);
    candidate.mixer.removeEventListener("loop", first);
    expect(candidate.updateRateReport.rate).toBe(1);
    candidate.mixer.removeEventListener("loop", second);
    expect(candidate.updateRateReport.rate).toBe(8);
    for (let frame = 0; frame < 6; frame += 1) candidate.update(1 / 60);
    candidate.mixer.addEventListener("loop", first);
    expect(candidate.updateRateReport.rate).toBe(1);
    expect(first).not.toHaveBeenCalled();
    candidate.update(1 / 60);
    candidate.dispose();
  });

  it("delivers later loop events after a listener registers in a mixer callback", () => {
    const onceClip = new AnimationClip("once", 0.05, [
      new NumberKeyframeTrack(".rotation[x]", [0, 0.05], [0, 1]),
    ]);
    const loopClip = new AnimationClip("loop", 0.05, [
      new NumberKeyframeTrack(".rotation[y]", [0, 0.05], [0, 1]),
    ]);
    const candidate = new AnimationPlayer({
      root: new Group(),
      clips: [onceClip, loopClip],
      strideSync: false,
      updateRate: 8,
    });
    candidate.play("once", { mode: "once" });
    candidate.mixer.clipAction(loopClip).play();
    const loopListener = vi.fn();
    candidate.mixer.addEventListener("finished", () => {
      candidate.mixer.addEventListener("loop", loopListener);
    });
    expect(() => {
      for (let frame = 0; frame < 4; frame += 1) candidate.update(1 / 60);
    }).not.toThrow();
    expect(loopListener).toHaveBeenCalledTimes(1);
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
      expect(rig.updateRateReport).toEqual({
        rate: 1,
        overridden: true,
        evaluated: true,
        boneRate: 1,
      });
    }
    rig.dispose();
  });

  it.each(["warp", "halt"] as const)(
    "preserves Three action time-scale interpolation at rates 1, 4 and 8 (%s)",
    (operation) => {
      for (const rate of [1, 4, 8]) {
        const clip = new AnimationClip("warp", 10, [
          new NumberKeyframeTrack(".rotation[x]", [0, 10], [0, 1]),
        ]);
        const expectedRoot = new Group();
        const expectedMixer = new AnimationMixer(expectedRoot);
        const expectedAction = expectedMixer.clipAction(clip).play();
        const actual = new AnimationPlayer({
          root: new Group(),
          clips: [clip],
          strideSync: false,
          updateRate: rate,
        });
        actual.play("warp");
        const actualAction = actual.mixer.clipAction(actual.clip("warp"));
        let skippedBeforeWarp = false;
        for (let frame = 0; frame < Math.max(3, rate); frame += 1) {
          expectedMixer.update(1 / 60);
          actual.update(1 / 60);
          skippedBeforeWarp ||= !actual.updateRateReport.evaluated;
        }
        if (rate > 1) expect(skippedBeforeWarp).toBe(true);
        if (operation === "warp") {
          expectedAction.warp(1, 2, 0.5);
          actualAction.warp(1, 2, 0.5);
        } else {
          expectedAction.halt(0.5);
          actualAction.halt(0.5);
        }
        let protectedFrames = 0;
        for (let frame = 0; frame < 300; frame += 1) {
          expectedMixer.update(1 / 60);
          actual.update(1 / 60);
          expect(actualAction.getEffectiveTimeScale()).toBeCloseTo(
            expectedAction.getEffectiveTimeScale(),
            10,
          );
          if (actual.updateRateReport.evaluated)
            expect(actualAction.time).toBeCloseTo(expectedAction.time, 10);
          if (
            !expectedAction.paused &&
            expectedAction.getEffectiveTimeScale() !== expectedAction.timeScale
          ) {
            protectedFrames += 1;
            expect(actual.updateRateReport).toMatchObject({ rate: 1, evaluated: true });
          }
        }
        actual.update(0, true);
        expect(actualAction.time).toBeCloseTo(expectedAction.time, 10);
        expect(actualAction.getEffectiveTimeScale()).toBeCloseTo(
          expectedAction.getEffectiveTimeScale(),
          10,
        );
        expect(protectedFrames).toBeGreaterThan(0);
        actual.dispose();
        expectedMixer.uncacheRoot(expectedRoot);
      }
    },
  );

  it("preserves unequal-duration warp-enabled crossfades at every requested rate", () => {
    const clips = [
      new AnimationClip("from", 4, [new NumberKeyframeTrack(".rotation[x]", [0, 4], [0, 1])]),
      new AnimationClip("to", 10, [new NumberKeyframeTrack(".rotation[y]", [0, 10], [0, 1])]),
    ];
    for (const rate of [1, 4, 8]) {
      const expectedRoot = new Group();
      const expectedMixer = new AnimationMixer(expectedRoot);
      const expectedFrom = expectedMixer.clipAction(clips[0] as AnimationClip).play();
      const expectedTo = expectedMixer
        .clipAction(clips[1] as AnimationClip)
        .setEffectiveWeight(1)
        .play();
      const actual = new AnimationPlayer({
        root: new Group(),
        clips,
        strideSync: false,
        updateRate: rate,
      });
      actual.play("from");
      const actualFrom = actual.mixer.clipAction(actual.clip("from")).play();
      const actualTo = actual.mixer.clipAction(actual.clip("to")).setEffectiveWeight(1).play();
      let skippedBeforeCrossfade = false;
      for (let frame = 0; frame < Math.max(3, rate); frame += 1) {
        expectedMixer.update(1 / 60);
        actual.update(1 / 60);
        skippedBeforeCrossfade ||= !actual.updateRateReport.evaluated;
      }
      if (rate > 1) expect(skippedBeforeCrossfade).toBe(true);
      expectedTo.crossFadeFrom(expectedFrom, 0.5, true);
      actualTo.crossFadeFrom(actualFrom, 0.5, true);
      let protectedFrames = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        expectedMixer.update(1 / 60);
        actual.update(1 / 60);
        const evaluated = actual.updateRateReport.evaluated;
        let protectedThisFrame = false;
        for (const [actualAction, expectedAction] of [
          [actualFrom, expectedFrom],
          [actualTo, expectedTo],
        ] as const) {
          expect(actualAction.getEffectiveTimeScale()).toBeCloseTo(
            expectedAction.getEffectiveTimeScale(),
            10,
          );
          if (evaluated) {
            expect(actualAction.time).toBeCloseTo(expectedAction.time, 10);
            expect(actualAction.getEffectiveWeight()).toBeCloseTo(
              expectedAction.getEffectiveWeight(),
              10,
            );
          }
          if (expectedAction.getEffectiveTimeScale() !== expectedAction.timeScale)
            protectedThisFrame = true;
        }
        if (protectedThisFrame) {
          protectedFrames += 1;
          expect(actual.updateRateReport).toMatchObject({ rate: 1, evaluated: true });
        }
      }
      actual.update(0, true);
      expect(actualFrom.time).toBeCloseTo(expectedFrom.time, 10);
      expect(actualTo.time).toBeCloseTo(expectedTo.time, 10);
      expect(protectedFrames).toBeGreaterThan(0);
      actual.dispose();
      expectedMixer.uncacheRoot(expectedRoot);
    }
  });

  it("does not recursively flush when a public warp starts in a mixer callback", () => {
    const clips = [
      new AnimationClip("loop", 1, [new NumberKeyframeTrack(".rotation[x]", [0, 1], [0, 1])]),
      new AnimationClip("once", 0.05, [new NumberKeyframeTrack(".rotation[y]", [0, 0.05], [0, 1])]),
    ];
    const actual = new AnimationPlayer({
      root: new Group(),
      clips,
      strideSync: false,
      updateRate: 8,
    });
    actual.play("loop");
    const loopAction = actual.mixer.clipAction(actual.clip("loop"));
    const onceAction = actual.mixer.clipAction(actual.clip("once")).setLoop(LoopOnce, 1).play();
    let warped = false;
    let callbackRate = 0;
    actual.mixer.addEventListener("finished", ({ action }) => {
      if (action === onceAction) {
        warped = true;
        loopAction.warp(1, 2, 0.1);
        callbackRate = actual.updateRateReport.rate;
      }
    });
    expect(() => {
      for (let frame = 0; frame < 30; frame += 1) actual.update(1 / 60);
    }).not.toThrow();
    expect(warped).toBe(true);
    expect(callbackRate).toBe(1);
    actual.dispose();
  });

  it("preserves warp-enabled public crossfades at rate 1", () => {
    const clips = [
      new AnimationClip("from", 1, [new NumberKeyframeTrack(".rotation[x]", [0, 1], [0, 1])]),
      new AnimationClip("to", 1, [new NumberKeyframeTrack(".rotation[y]", [0, 1], [0, 1])]),
    ];
    const expectedRoot = new Group();
    const expectedMixer = new AnimationMixer(expectedRoot);
    const expectedFrom = expectedMixer.clipAction(clips[0] as AnimationClip).play();
    const expectedTo = expectedMixer.clipAction(clips[1] as AnimationClip).play();
    const actual = new AnimationPlayer({
      root: new Group(),
      clips,
      strideSync: false,
      updateRate: 1,
    });
    actual.play("from");
    const actualFrom = actual.mixer.clipAction(actual.clip("from")).play();
    const actualTo = actual.mixer.clipAction(actual.clip("to")).setEffectiveWeight(1).play();
    expectedTo.crossFadeFrom(expectedFrom, 0.5, true);
    actualTo.crossFadeFrom(actualFrom, 0.5, true);
    for (let frame = 0; frame < 30; frame += 1) {
      expectedMixer.update(1 / 60);
      actual.update(1 / 60);
      expect(actualFrom.getEffectiveWeight()).toBeCloseTo(expectedFrom.getEffectiveWeight(), 10);
      expect(actualTo.getEffectiveWeight()).toBeCloseTo(expectedTo.getEffectiveWeight(), 10);
      expect(actualFrom.getEffectiveTimeScale()).toBeCloseTo(
        expectedFrom.getEffectiveTimeScale(),
        10,
      );
      expect(actualTo.getEffectiveTimeScale()).toBeCloseTo(expectedTo.getEffectiveTimeScale(), 10);
    }
    actual.dispose();
    expectedMixer.uncacheRoot(expectedRoot);
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
    expect(animationRateStates.get(rig.root)?.effectiveRate).toBe(1);
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

describe("camera-rate walk cost", () => {
  // Lantern Vale on the web engine: the camera-rate pass walked every visible object to find the few
  // rigs, and each object's userData, geometry and parent read crossed into the engine. It was 41% of
  // the main thread. Scenery that no rig owns and no stand-in observes is not read at all.
  it("reads nothing from scenery that carries no animation rate", () => {
    const rig = player(1);
    const view = rendered(rig, -20);
    let reads = 0;
    for (let index = 0; index < 50; index += 1) {
      const prop = new Mesh(new SphereGeometry(1, 8, 6), new MeshBasicMaterial());
      prop.position.set(index, 0, -30);
      const { geometry, userData } = prop;
      Object.defineProperty(prop, "geometry", { get: () => (reads += 1) && geometry });
      Object.defineProperty(prop, "userData", { get: () => (reads += 1) && userData });
      // The walk itself does not reach scenery either: it starts at the rigs.
      Object.defineProperty(prop, "visible", { get: () => (reads += 1) > 0, set: () => {} });
      view.scene.add(prop);
    }
    view.scene.updateMatrixWorld(true);
    reads = 0;
    view.cull.prepareAnimation(view.scene, view.camera, 720);
    expect(reads).toBe(0);
    // The rig is still observed on the frame the walk published.
    const state = animationRateStates.get(rig.root);
    expect(state?.source).toBe(view.cull);
    expect(state?.frame).toBe(view.cull.animationFrame);
    rig.dispose();
  });

  // Lantern Vale battle capture: each rig part walked its parents to the scene root twice a frame
  // (rate states, then camera attachment), 7% of the main thread. The parts above a rig are read
  // once per rig, not once per part.
  it("reads the groups above a rig once per rig, not once per part", () => {
    const rig = player(1);
    const view = rendered(rig, -20);
    for (let index = 0; index < 20; index += 1) {
      const part = new Mesh(new SphereGeometry(0.2, 8, 6), new MeshBasicMaterial());
      part.position.x = index * 0.1;
      rig.root.add(part);
    }
    let outer: Group = view.scene as unknown as Group;
    const groups: Group[] = [];
    for (let depth = 0; depth < 8; depth += 1) {
      const group = new Group();
      outer.add(group);
      groups.push(group);
      outer = group;
    }
    outer.add(rig.root);
    view.scene.updateMatrixWorld(true);
    let reads = 0;
    for (const group of groups) {
      const parent = group.parent;
      Object.defineProperty(group, "parent", {
        get: () => (reads += 1) && parent,
        configurable: true,
      });
    }
    view.cull.prepareAnimation(view.scene, view.camera, 720);
    expect(reads).toBeLessThanOrEqual(groups.length);
    const state = animationRateStates.get(rig.root);
    expect(state?.frame).toBe(view.cull.animationFrame);
    expect(state?.rate).toBe(1);
    rig.dispose();
  });
});
