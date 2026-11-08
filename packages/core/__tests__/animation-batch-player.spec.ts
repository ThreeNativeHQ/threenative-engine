/**
 * PRD-828 Phase 2: the tick that used to walk a rig property by property walks a whole frame's rigs in
 * one call instead, and every rig has to come out where the JS loop would have left it.
 *
 * The native side of the batch has its own C++ cases (`tick_batch_test.cpp`). This is the other half —
 * the player's wiring — against a reference that runs the same documented rules over the same objects.
 * Two runs of one rig, one with the batch installed and one with the JS loop, must agree on the pose,
 * the stride report and the counters, on a fixed seed, including the frames a rate band holds.
 */
import {
  type AnimationAction,
  AnimationClip,
  type AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import { afterEach, describe, expect, it } from "vitest";

import { type IAnimationTickRig, clearAnimationTicks } from "../src/animation-batch.js";
import { AnimationPlayer } from "../src/animation.js";

const STRIDE_RATE_MIN = 0.15;
const STRIDE_RATE_MAX = 3;
const STRIDE_SPEED_FLOOR = 1e-4;
const CLIP_GROUND_FLOOR = 1e-3;

const scratch = new Vector3();

interface ITickState {
  hasLast: boolean;
  x: number;
  z: number;
  pending: number;
  elapsed: number;
}

/**
 * The batch's rules, as `tick_batch.cpp` runs them, over the objects a descriptor names. A reference,
 * not the engine: it is deliberately the arithmetic the native cases pin, so this spec fails when the
 * player's wiring and the engine's rules stop describing the same frame.
 */
function referenceBatch(): (rigs: readonly IAnimationTickRig[], status: Float64Array) => void {
  // One mixer is one rig, so the body's last position and the banked advance follow the rig across a
  // clip change; `reset` is what starts the measurement over.
  const states = new Map<object, ITickState>();
  return (rigs, status) => {
    for (let i = 0; i < rigs.length; i += 1) {
      const rig = rigs[i] as IAnimationTickRig;
      const mixer = rig.mixer as AnimationMixer;
      const action = rig.action as AnimationAction | null;
      const out = i * 3;
      let state = states.get(mixer);
      if (state === undefined) {
        state = { hasLast: false, x: 0, z: 0, pending: 0, elapsed: 0 };
        states.set(mixer, state);
      }
      if (rig.reset) {
        state.hasLast = false;
        state.pending = 0;
        state.elapsed = 0;
      }
      if (action === null) {
        if (rig.step) mixer.update(rig.elapsed);
        status[out + 2] = rig.elapsed > 0 ? 2 : 0;
        continue;
      }
      const scaleBefore = action.timeScale;
      state.pending += rig.elapsed * scaleBefore;
      state.elapsed += rig.elapsed;
      const body = rig.strideRoot as Object3D | null;
      let moved = 0;
      if (body !== null) {
        body.getWorldPosition(scratch);
        if (state.hasLast) moved = Math.hypot(scratch.x - state.x, scratch.z - state.z);
        state.x = scratch.x;
        state.z = scratch.z;
        state.hasLast = true;
      }
      const groundSpeed = rig.dt > 0 ? moved / rig.dt : 0;
      status[out + 1] = groundSpeed;
      const measured = rig.dt > 0;
      const locomotion = rig.clipGroundSpeed >= CLIP_GROUND_FLOOR;
      const rate = !measured
        ? 1
        : locomotion
          ? Math.min(
              STRIDE_RATE_MAX,
              Math.max(
                STRIDE_RATE_MIN,
                groundSpeed < STRIDE_SPEED_FLOOR
                  ? STRIDE_RATE_MIN
                  : groundSpeed / rig.clipGroundSpeed,
              ),
            )
          : 1;
      const applies = measured && locomotion && rig.strideSync;
      let flags = 0;
      if (rig.step) {
        const duration = action.getClip().duration;
        let advance = state.pending;
        if (action.loop === LoopRepeat && duration > 0) {
          const end = action.time + advance;
          const seam = Math.round(end / duration) * duration;
          if (Math.abs(end - seam) <= Number.EPSILON * 16 * Math.max(duration, Math.abs(end)))
            advance = seam - action.time;
        }
        const scale = state.elapsed > 0 ? advance / state.elapsed : scaleBefore;
        if (scale !== scaleBefore) action.setEffectiveTimeScale(scale);
        const before = mixer.time;
        const wasScheduled = action.isScheduled();
        mixer.update(state.elapsed);
        state.pending = 0;
        state.elapsed = 0;
        if (mixer.time !== before || wasScheduled !== action.isScheduled()) flags |= 2;
        if (
          action.loop === LoopOnce &&
          (!action.isScheduled() ||
            (action.time >= action.getClip().duration && action.time > before))
        )
          flags |= 1;
      }
      let target = scaleBefore;
      if (applies) target = rate;
      else if (measured && rig.lastRate !== 0 && scaleBefore === rig.lastRate) target = 1;
      if (action.timeScale !== target) action.setEffectiveTimeScale(target);
      status[out] = rate;
      status[out + 2] = flags;
    }
  };
}

interface ITrace {
  readonly strideRate: readonly number[];
  readonly groundSpeed: readonly number[];
  readonly synced: readonly boolean[];
  readonly advancedFrames: number;
  readonly actionTimes: readonly number[];
  /** Rigs the engine's batch actually ran. Zero means the JS loop took every tick — a false green. */
  readonly batchedRigs: number;
  readonly batches: number;
}

/**
 * One run of a walking rig: a clip carrying 10 m a clip-second against a body whose ground speed grows
 * every frame, so the stride rule's rate changes between frames and a held interval has to integrate.
 *
 * The rig sits under a holder because that is how a game moves one: the clip animates a child, and the
 * stride reads the rig's own world position, so the two ends of the measurement stay separate.
 */
function walk(batched: boolean, frames: number, hold: boolean): ITrace {
  const holder = new Object3D();
  const root = new Object3D();
  const child = new Object3D();
  child.name = "child";
  holder.add(root);
  root.add(child);
  const clip = new AnimationClip("walk", 1, [
    new VectorKeyframeTrack("child.position", [0, 1], [0, 0, 0, 10, 0, 0]),
  ]);
  const player = new AnimationPlayer({ root, clips: [clip] });
  // `hold` asks for a pose every fourth frame by hand rather than by band: the band's stagger is a
  // process-wide counter, so two players built in one test would pose on different frames and the two
  // traces would be comparing their schedules rather than their rules.
  player.updateRate = hold ? 4_000 : "auto";
  player.play("walk");
  const action = player.mixer.clipAction(clip);
  if (batched) (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = referenceBatch();
  let batchedRigs = 0;
  let batches = 0;
  if (batched) {
    const reference = referenceBatch();
    (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = (
      rigs: readonly IAnimationTickRig[],
      status: Float64Array,
    ) => {
      batches += 1;
      batchedRigs += rigs.length;
      reference(rigs, status);
    };
  }
  const strideRate: number[] = [];
  const groundSpeed: number[] = [];
  const synced: boolean[] = [];
  const actionTimes: number[] = [];
  // A fixed seed: the body's path is a deterministic function of the frame number.
  for (let frame = 1; frame <= frames; frame += 1) {
    holder.position.x = 0.05 * frame * frame;
    player.update(0.1, hold && frame % 4 === 0);
    // The frame loop's flush is the player's own: a report read settles the queued tick first.
    const stride = player.stride;
    strideRate.push(stride.rate);
    groundSpeed.push(stride.groundSpeed);
    synced.push(stride.synced);
    actionTimes.push(action.time);
  }
  return {
    strideRate,
    groundSpeed,
    synced,
    advancedFrames: player.advancedFrames,
    actionTimes,
    batchedRigs,
    batches,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__tnAnimationTick");
  clearAnimationTicks();
});

describe("the animation tick batch in the player (PRD-828)", () => {
  it("leaves the rig where the JS loop leaves it, frame by frame", () => {
    const js = walk(false, 12, false);
    const batched = walk(true, 12, false);
    // The batch ran every tick, once per frame: a spec that compared two JS runs would pass and prove
    // nothing.
    expect(batched.batches).toBe(12);
    expect(batched.batchedRigs).toBe(12);
    expect(js.batchedRigs).toBe(0);
    expect(batched.strideRate).toEqual(js.strideRate);
    expect(batched.groundSpeed).toEqual(js.groundSpeed);
    expect(batched.synced).toEqual(js.synced);
    expect(batched.advancedFrames).toBe(js.advancedFrames);
    expect(batched.actionTimes.length).toBe(js.actionTimes.length);
    for (let frame = 0; frame < js.actionTimes.length; frame += 1)
      expect(batched.actionTimes[frame]).toBeCloseTo(js.actionTimes[frame] as number, 12);
  });

  it("agrees with the JS loop when a rate band holds the rig between poses", () => {
    const js = walk(false, 32, true);
    const batched = walk(true, 32, true);
    // Eight poses in thirty-two frames, and every held frame went through the batch instead of the JS
    // loop's banked `dt`.
    expect(batched.batches).toBe(32);
    expect(batched.batchedRigs).toBe(32);
    expect(js.batchedRigs).toBe(0);
    expect(batched.strideRate).toEqual(js.strideRate);
    expect(batched.groundSpeed).toEqual(js.groundSpeed);
    expect(batched.synced).toEqual(js.synced);
    expect(batched.advancedFrames).toBe(js.advancedFrames);
    for (let frame = 0; frame < js.actionTimes.length; frame += 1)
      expect(batched.actionTimes[frame]).toBeCloseTo(js.actionTimes[frame] as number, 12);
  });

  it("measures the same body across a clip change, and starts over only on a reset", () => {
    // The stride belongs to the rig's body, not to the clip: a walk→run change must not floor the rate for
    // a frame, and returning to an earlier clip must not divide seconds of travel by one frame.
    const run = (batched: boolean): { readonly first: number; readonly changed: number } => {
      const holder = new Object3D();
      const root = new Object3D();
      const child = new Object3D();
      child.name = "child";
      holder.add(root);
      root.add(child);
      const walkClip = new AnimationClip("walk", 1, [
        new VectorKeyframeTrack("child.position", [0, 1], [0, 0, 0, 10, 0, 0]),
      ]);
      const runClip = new AnimationClip("run", 1, [
        new VectorKeyframeTrack("child.position", [0, 1], [0, 0, 0, 10, 0, 0]),
      ]);
      const player = new AnimationPlayer({ root, clips: [walkClip, runClip] });
      player.play("walk");
      if (batched)
        (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = referenceBatch();
      const step = (metres: number) => {
        holder.position.x = metres;
        player.update(0.1);
        return player.stride.rate;
      };
      // 1 m a tick against a 10 m/s clip: rate 1, so a floor frame would show as 0.15.
      for (let frame = 1; frame <= 3; frame += 1) step(frame);
      player.play("run");
      const changed = step(4);
      return { first: 0, changed };
    };
    const js = run(false);
    const batched = run(true);
    // Both hold the rate the body implies on the first clip after a change: 10 m/s against a 10 m/s clip.
    expect(batched.changed).toBeCloseTo(js.changed, 12);
    expect(batched.changed).toBeCloseTo(1, 12);
  });

  it("advances the rig once when a game plays a clip after updating it in the same frame", () => {
    // `c.update(dt); if (hit) c.play("Hit")` is an ordinary frame: the tick is queued and unflushed
    // when the clip change flushes the player's own pending time. Spending it there and again in the
    // batch's flush advances the rig twice and puts the stride on a clip that is no longer playing.
    const run = (batched: boolean): { readonly mixerTime: number; readonly clip: string } => {
      const root = new Object3D();
      const child = new Object3D();
      child.name = "child";
      root.add(child);
      const walkClip = new AnimationClip("walk", 1, [
        new VectorKeyframeTrack("child.position", [0, 1], [0, 0, 0, 10, 0, 0]),
      ]);
      const hitClip = new AnimationClip("hit", 1, [
        new VectorKeyframeTrack("child.position", [0, 1], [0, 0, 0, 5, 0, 0]),
      ]);
      const player = new AnimationPlayer({ root, clips: [walkClip, hitClip] });
      player.play("walk");
      if (batched)
        (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = referenceBatch();
      child.position.x = 0.1;
      player.update(0.1);
      player.play("hit", { mode: "once" });
      // The frame's end: whatever settles the queue runs here, and a tick spent twice shows up in the
      // mixer's clock, not in the report.
      player.stride;
      return { mixerTime: player.mixer.time, clip: player.current ?? "" };
    };
    const js = run(false);
    const batched = run(true);
    expect(batched.clip).toBe(js.clip);
    expect(batched.mixerTime).toBeCloseTo(js.mixerTime, 12);
  });
});
