import { GPUParticles3D, GPUReadback, type ICtx } from "@threenative/core";
import { Vector3 } from "three";
import { Fn, If, float, hash, instanceIndex, instancedArray, uint, vec3 } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { createImpactSparks } from "../render/combat.js";
import type { GalleryState } from "./Gallery.js";

export function createBurstProbe(ctx: ICtx<GalleryState>): () => void {
  if (typeof location === "undefined") return () => undefined;
  const query = new URLSearchParams(location.search);
  if (!query.has("burstProbe")) return () => undefined;
  const arm = query.get("burstProbe");
  return arm === "spawn" || arm === "overflow"
    ? createSpawnProbe(ctx, arm)
    : createRestartProbe(ctx);
}

/** Opt-in (`?burstProbe`): drives the restart-based burst of the action-rpg template and reads it back. */
function createRestartProbe(ctx: ICtx<GalleryState>): () => void {
  const option = createImpactSparks(83)[0];
  if (option === undefined) throw new Error("Burst probe requires an impact-sparks layer.");
  const particles = ctx.add(new GPUParticles3D(option));
  particles.name = "burst-probe-sparks";
  particles.visible = false; // engine-override: the restart arm reproduces the shipped hide-until-burst pattern it measures
  const readback = new GPUReadback({
    attribute: particles.buffers.positions.value,
    everyFrames: 1,
  });
  particles.addEventListener("removed", () => readback.dispose());
  const metrics = {
    amount: -1,
    meanAgeFractionFirstFrame: -1,
    maxOneFrameMoveAtSecondBurst: -1,
    secondBurstHiddenAtFrame: -1,
    firstBurstVisibleFrames: -1,
    samples: -1,
    done: false,
  };
  ctx.entities.add("burst-probe", { mesh: particles, debug: () => ({ ...metrics }) });
  let frame = 0;
  let firstFrame = -1;
  let secondFrame = -1;
  let lands = 0;
  let visibleFrames = 0;
  let firstHidden = false;
  let hiddenAtFrame = -1;
  const draws = new Map<number, { x: number; visible: boolean }>();
  const samples: {
    frame: number;
    staleFrames: number;
    drawnFrame: number;
    x: number;
    visible: boolean;
    data: Float32Array;
  }[] = [];
  const burst = (x: number): void => {
    particles.position.set(x, 0.5, 0);
    particles.visible = true;
    particles.restart();
    ctx.after(0.45, () => {
      particles.visible = false; // engine-override: the restart arm reproduces the shipped hide-after-burst pattern it measures
    });
  };
  ctx.beforeRender(() => {
    frame += 1;
    if (firstFrame < 0 || frame > firstFrame + 60) return;
    draws.set(frame, { x: particles.position.x, visible: particles.visible });
    if (!firstHidden && particles.visible) visibleFrames += 1;
    if (!particles.visible && !firstHidden) {
      firstHidden = true;
      hiddenAtFrame = frame - secondFrame;
    }
    // The render compute has run; staleness identifies the draw that supplied these bytes.
    readback.request(ctx.renderer);
    const sample = readback.sample;
    if (sample === undefined || readback.stats.lands === lands) return;
    lands = readback.stats.lands;
    const drawnFrame = frame - sample.staleFrames;
    const draw = draws.get(drawnFrame);
    if (draw === undefined) throw new Error("Burst probe readback has no matching draw.");
    samples.push({
      frame,
      staleFrames: sample.staleFrames,
      drawnFrame,
      ...draw,
      data: Float32Array.from(sample.data),
    });
  });
  return () => {
    if (frame >= 30 && firstFrame < 0) {
      firstFrame = frame + 1;
      burst(-2);
      ctx.after(0.3, () => {
        secondFrame = frame + 1;
        burst(2);
      });
    }
    if (frame <= firstFrame + 60 || metrics.done) return;
    readback.dispose();
    const a = samples.filter((sample) => sample.drawnFrame < secondFrame);
    const first = a.find((sample) => sample.staleFrames === 0) ?? a[0];
    const before = a.at(-1);
    const after = samples.find((sample) => sample.drawnFrame >= secondFrame);
    if (!first || !before || !after || hiddenAtFrame < 0)
      throw new Error("Burst probe window lacks A/B readbacks or the second burst hide.");
    // Three updates itemSize when WebGPU pads vec3 storage to vec4.
    const stride = particles.buffers.positions.value.itemSize;
    if (samples.some(({ data }) => data.length !== particles.amount * stride))
      throw new Error("Burst probe buffer size does not match its particle count.");
    const positions = (data: Float32Array): Vector3[] =>
      Array.from({ length: particles.amount }, (_, i) => new Vector3().fromArray(data, i * stride));
    const allRadii = a
      .flatMap(({ data }) => positions(data).map((p) => p.length()))
      .sort((a, b) => a - b);
    const rMax = allRadii[Math.ceil(allRadii.length * 0.95) - 1] ?? 0;
    if (rMax <= 0 || !allRadii.every(Number.isFinite))
      throw new Error("Burst probe has no positive finite A-window radius.");
    const previous = positions(before.data);
    const emitterMove = new Vector3(after.x - before.x, 0, 0);
    const moves = positions(after.data).map((p, i) =>
      p.add(emitterMove).distanceTo(previous[i] ?? new Vector3(Number.NaN, 0, 0)),
    );
    metrics.amount = particles.amount;
    metrics.meanAgeFractionFirstFrame =
      positions(first.data).reduce(
        (sum, p) => sum + Math.min(1, Math.max(0, p.length() / rMax)),
        0,
      ) / particles.amount;
    metrics.maxOneFrameMoveAtSecondBurst = Math.max(...moves);
    if (
      ![metrics.meanAgeFractionFirstFrame, metrics.maxOneFrameMoveAtSecondBurst].every(
        Number.isFinite,
      )
    )
      throw new Error("Burst probe readback contains nonfinite positions.");
    metrics.secondBurstHiddenAtFrame = hiddenAtFrame;
    metrics.firstBurstVisibleFrames = visibleFrames;
    metrics.samples = samples.length;
    metrics.done = true;
  };
}

interface IJoinedSample {
  drawnFrame: number;
  staleFrames: number;
  positions: Float32Array;
  births: Float32Array;
  clock: number;
}

function createSpawnProbe(ctx: ICtx<GalleryState>, arm: "spawn" | "overflow"): () => void {
  const clock = instancedArray(1, "float");
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  material.scaleNode = float(0.04);
  material.colorNode = vec3(1, 0.8, 0.3);
  const particles = ctx.add(
    new GPUParticles3D({
      amount: 64,
      material,
      lifetime: 0.5,
      spawn: (buffers, request) =>
        Fn(() => {
          If(instanceIndex.lessThan(request.count), () => {
            const slot = request.first.add(instanceIndex).mod(uint(64));
            const seed = uint(request.seed).mul(uint(1024)).add(instanceIndex);
            const jitter = vec3(hash(seed), hash(seed.add(101)), hash(seed.add(211)))
              .sub(0.5)
              .mul(0.1);
            buffers.positions.element(slot).assign(request.origin.add(jitter));
            // Uniform spherical direction avoids normalizing a possibly zero hash vector.
            const z = hash(seed.add(307)).mul(2).sub(1);
            const angle = hash(seed.add(401)).mul(Math.PI * 2);
            const radius = float(1).sub(z.mul(z)).sqrt();
            const direction = vec3(radius.mul(angle.cos()), radius.mul(angle.sin()), z);
            buffers.velocities
              .element(slot)
              .assign(direction.mul(hash(seed.add(503)).mul(2).add(2)));
          });
        })().compute(64),
      process: (buffers, runtime) =>
        Fn(() => {
          if (buffers.births === undefined) throw new Error("Spawn probe requires birth stamps.");
          const age = runtime.time.sub(buffers.births.element(instanceIndex));
          If(age.greaterThanEqual(0).and(age.lessThan(0.5)), () => {
            buffers.positions
              .element(instanceIndex)
              .addAssign(buffers.velocities.element(instanceIndex).mul(runtime.delta));
          });
          If(instanceIndex.equal(uint(0)), () => clock.element(uint(0)).assign(runtime.time));
        })().compute(64),
    }),
  );
  particles.name = `burst-probe-${arm}`;
  if (particles.buffers.births === undefined) throw new Error("Spawn probe requires births.");
  const readbacks = [
    particles.buffers.positions.value,
    particles.buffers.births.value,
    clock.value,
  ].map((attribute) => new GPUReadback({ attribute, everyFrames: 1 }));
  const dispose = (): void => {
    for (const readback of readbacks) readback.dispose();
    clock.value.dispose();
  };
  particles.addEventListener("removed", dispose);
  const spawnMetrics = {
    amount: -1,
    firstFrameMaxRadius: -1,
    firstFrameMeanAgeSeconds: -1,
    firstFrameStale: -1,
    maxOneFrameMoveOfFirstBurst: -1,
    bothBurstsLiveFull: -1,
    spawned: -1,
    clamped: -1,
    samples: -1,
    done: false,
  };
  const overflowMetrics = {
    clamped: -1,
    spawned: -1,
    nonFinite: -1,
    threw: -1,
    samples: -1,
    done: false,
  };
  ctx.entities.add("burst-probe", {
    mesh: particles,
    debug: () => ({ ...(arm === "spawn" ? spawnMetrics : overflowMetrics) }),
  });
  let frame = 0;
  let firstFrame = -1;
  let secondFrame = -1;
  let firstAt = -1;
  let threw = 0;
  let nonFinite = 0;
  const window = arm === "spawn" ? 60 : 20;
  const lands = [0, 0, 0];
  const pending = readbacks.map(
    () => new Map<number, { data: Float32Array; staleFrames: number }>(),
  );
  const samples: IJoinedSample[] = [];
  const stopReadbacks = ctx.beforeRender(() => {
    frame += 1;
    if (firstFrame < 0 || frame > firstFrame + window) return;
    // Each request advances its own readback frame clock exactly once per world render.
    for (const readback of readbacks) readback.request(ctx.renderer);
    for (const [index, readback] of readbacks.entries()) {
      const sample = readback.sample;
      if (sample === undefined || readback.stats.lands === lands[index]) continue;
      lands[index] = readback.stats.lands;
      const drawnFrame = frame - sample.staleFrames;
      const data = Float32Array.from(sample.data);
      pending[index]?.set(drawnFrame, { data, staleFrames: sample.staleFrames });
      if (index === 0) nonFinite += data.filter((value) => !Number.isFinite(value)).length;
    }
    const [positions, births, clocks] = pending;
    if (!positions || !births || !clocks) throw new Error("Spawn probe lacks readbacks.");
    for (const [drawnFrame, position] of positions) {
      const birth = births.get(drawnFrame);
      const time = clocks.get(drawnFrame);
      if (!birth || !time) continue;
      const now = time.data[0];
      if (now === undefined || !Number.isFinite(now))
        throw new Error("Spawn probe clock is missing or nonfinite.");
      samples.push({
        drawnFrame,
        staleFrames: Math.max(
          position.staleFrames,
          birth.staleFrames,
          time.staleFrames,
          frame - drawnFrame,
        ),
        positions: position.data,
        births: birth.data,
        clock: now,
      });
      positions.delete(drawnFrame);
      births.delete(drawnFrame);
      clocks.delete(drawnFrame);
    }
  });
  return () => {
    if (frame >= 30 && firstFrame < 0) {
      firstFrame = frame + 1;
      firstAt = performance.now() / 1000;
      if (arm === "spawn") {
        particles.emitParticle({ count: 49, origin: { x: -2, y: 0.5, z: 0 } });
      } else {
        for (const x of [-2, 0, 2]) {
          try {
            particles.emitParticle({ count: 64, origin: { x, y: 0.5, z: 0 } });
          } catch {
            threw = 1;
          }
        }
      }
    }
    if (
      arm === "spawn" &&
      firstFrame >= 0 &&
      secondFrame < 0 &&
      performance.now() / 1000 - firstAt >= 0.3
    ) {
      secondFrame = frame + 1;
      particles.emitParticle({ count: 49, origin: { x: 2, y: 0.5, z: 0 } });
    }
    if (firstFrame < 0 || frame <= firstFrame + window || spawnMetrics.done || overflowMetrics.done)
      return;
    stopReadbacks();
    dispose();
    samples.sort((a, b) => a.drawnFrame - b.drawnFrame);
    if (samples.length === 0 || readbacks.some((readback) => readback.stats.failures > 0))
      throw new Error("Spawn probe has no joined samples or a GPU readback failed.");
    if (arm === "overflow") {
      Object.assign(overflowMetrics, {
        clamped: particles.stats.clamped,
        spawned: particles.stats.spawned,
        nonFinite,
        threw,
        samples: samples.length,
        done: true,
      });
      return;
    }
    const stride = particles.buffers.positions.value.itemSize;
    if (
      nonFinite > 0 ||
      samples.some(
        (sample) =>
          sample.positions.length !== 64 * stride ||
          sample.births.length !== 64 ||
          !sample.births.every(Number.isFinite),
      )
    )
      throw new Error("Spawn probe buffers have invalid sizes or nonfinite values.");
    const first = samples.find(
      (sample) => sample.drawnFrame >= firstFrame && sample.births.some((birth) => birth >= 0),
    );
    const second = samples.find(
      (sample) =>
        sample.drawnFrame >= secondFrame &&
        sample.births.some((birth) => first && birth > Math.max(...first.births) + 1e-3),
    );
    if (!first || !second || first.drawnFrame >= secondFrame)
      throw new Error("Spawn probe lacks distinct A/B samples.");
    const firstStamp = Math.max(...first.births);
    const secondStamp = Math.max(...second.births);
    const point = (sample: IJoinedSample, i: number): Vector3 =>
      new Vector3().fromArray(sample.positions, i * stride);
    const firstLive = Array.from(first.births.keys()).filter((i) => (first.births[i] ?? -1) >= 0);
    const moves = (before: IJoinedSample, after: IJoinedSample, stamp: number): number[] =>
      Array.from(before.births.keys())
        .filter(
          (i) =>
            Math.abs((before.births[i] ?? -1e6) - stamp) < 1e-3 &&
            Math.abs((after.births[i] ?? -1e6) - stamp) < 1e-3,
        )
        .map((i) => point(before, i).distanceTo(point(after, i)));
    const secondMoves = samples.flatMap((after, index) => {
      const before = samples[index - 1];
      return before &&
        after.drawnFrame - before.drawnFrame === 1 &&
        after.drawnFrame >= second.drawnFrame &&
        after.drawnFrame <= second.drawnFrame + 10
        ? moves(before, after, firstStamp)
        : [];
    });
    if (secondMoves.length === 0)
      throw new Error("Spawn probe lacks consecutive A samples around B.");
    const movingAt = (stamp: number): boolean => {
      const target = stamp + 0.4;
      const before = samples.filter((sample) => sample.clock <= target).at(-1);
      const after = samples.find((sample) => sample.clock > target);
      if (!before || !after || target - before.clock > 0.08 || after.clock - target > 0.08)
        throw new Error("Spawn probe lacks lifetime samples near age 0.4 seconds.");
      return moves(before, after, stamp).some((distance) => distance > 0.01);
    };
    Object.assign(spawnMetrics, {
      amount: particles.amount,
      firstFrameMaxRadius: Math.max(
        ...firstLive.map((i) => point(first, i).distanceTo(new Vector3(-2, 0.5, 0))),
      ),
      firstFrameMeanAgeSeconds:
        firstLive.reduce((sum, i) => sum + first.clock - (first.births[i] ?? Number.NaN), 0) /
        firstLive.length,
      firstFrameStale: first.staleFrames,
      maxOneFrameMoveOfFirstBurst: Math.max(...secondMoves),
      bothBurstsLiveFull: movingAt(firstStamp) && movingAt(secondStamp) ? 1 : 0,
      spawned: particles.stats.spawned,
      clamped: particles.stats.clamped,
      samples: samples.length,
      done: true,
    });
  };
}
