import { AnimationComposer, AnimationPlayer, type ICtx } from "@threenative/core";
import { Group } from "three";
import { compositionClips, compositionLayers, compositionSamples } from "./clips.js";
import { type characterSource, cloneCharacter } from "./render/character.js";

export type BenchmarkMode = "none" | "baseline" | "candidate";
declare const __TN_ANIMATION_BENCHMARK__: BenchmarkMode;
export const benchmarkMode =
  typeof __TN_ANIMATION_BENCHMARK__ === "undefined" ? "none" : __TN_ANIMATION_BENCHMARK__;

/** Scene-frame CPU is accumulated per actual render; fixed-step batches cannot invent frames. */
export class CompositionBenchmark {
  readonly #players: (AnimationComposer | AnimationPlayer)[] = [];
  readonly #skins: ReturnType<typeof cloneCharacter>[] = [];
  readonly #measured = new Float64Array(1800);
  #frames = 0;
  #presentedFrames = 0;
  #pendingUpdates = 0;
  #warmupUpdates = 0;
  #measuredUpdates = 0;
  #pendingSeconds = 0;
  #measuredSeconds = 0;
  #pendingMs = 0;
  #p95: number | undefined;

  constructor(
    ctx: Pick<ICtx, "add">,
    source: ReturnType<typeof characterSource>,
    readonly mode: Exclude<BenchmarkMode, "none">,
  ) {
    for (let i = 0; i < 100; i += 1) {
      const rig = cloneCharacter(source);
      const body = new Group();
      body.position.set(((i % 10) - 4.5) * 1.6, 0.85, (Math.floor(i / 10) - 4.5) * 1.6);
      body.add(rig.root);
      ctx.add(body);
      this.#skins.push(rig);
      if (mode === "candidate") {
        const player = new AnimationComposer({
          root: rig.root,
          clips: compositionClips,
          samples: compositionSamples,
          layers: compositionLayers,
        });
        player.setWeights([0.25, 0.5, 0.25]);
        player.setLayerWeight("reload", 0.4);
        player.setLayerWeight("recoil", 0.3);
        this.#players.push(player);
      } else {
        const player = new AnimationPlayer({
          root: rig.root,
          clips: compositionClips.slice(0, 3),
          strideSync: false,
        });
        player.playWeighted([
          { clip: "walk", weight: 0.25 },
          { clip: "run", weight: 0.5 },
          { clip: "strafe", weight: 0.25 },
        ]);
        this.#players.push(player);
      }
    }
  }

  update(dt: number): void {
    if (dt === 0) return;
    const before = performance.now();
    for (const player of this.#players) player.update(dt);
    this.#pendingMs += performance.now() - before;
    this.#pendingUpdates += 1;
    this.#pendingSeconds += dt;
  }

  rendered(): void {
    this.#presentedFrames += 1;
    // A frozen fixed clock can still present; it cannot warm up or measure animation work.
    if (this.#pendingUpdates === 0) return;
    this.#frames += 1;
    if (this.#frames <= 300) this.#warmupUpdates += this.#pendingUpdates;
    if (this.#frames > 300 && this.#frames <= 2100) {
      this.#measured[this.#frames - 301] = this.#pendingMs;
      this.#measuredUpdates += this.#pendingUpdates;
      this.#measuredSeconds += this.#pendingSeconds;
    }
    this.#pendingMs = 0;
    this.#pendingUpdates = 0;
    this.#pendingSeconds = 0;
    if (this.#frames === 2100) {
      const sorted = this.#measured.slice().sort();
      this.#p95 = sorted[Math.ceil(1800 * 0.95) - 1];
    }
  }

  observation() {
    return {
      mode: this.mode,
      rigs: this.#players.length,
      bones: 9,
      actions: Math.max(...this.#players.map((player) => player.mixer.stats.actions.inUse)),
      presentedFrames: this.#presentedFrames,
      warmupUpdates: this.#warmupUpdates,
      measuredUpdates: this.#measuredUpdates,
      measuredSeconds: this.#measuredSeconds,
      warmupFrames: Math.min(300, this.#frames),
      measuredFrames: Math.min(1800, Math.max(0, this.#frames - 300)),
      cpuP95Ms: this.#p95 ?? null,
    };
  }

  dispose(): void {
    for (const player of this.#players) player.dispose();
    for (const rig of this.#skins) rig.skin.skeleton.dispose();
    this.#players.length = 0;
    this.#skins.length = 0;
  }
}
