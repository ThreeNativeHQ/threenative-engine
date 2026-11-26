import { Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { PerspectiveCamera } from "three";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { Performer } from "../entities/Performer.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createStageCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { playerMaterial, teacherMaterial } from "../render/props.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { PLAYER_X, Stage, TEACHER_X } from "../render/stage.js";
import { BUTTONS } from "../rhythm/buttons.js";
import { BPM, LINES } from "../rhythm/chart.js";
import { Session, type SessionEvent } from "../rhythm/session.js";
import type { GameState } from "../state.js";

/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 1.4;

const round = (value: number, scale = 1000): number => Math.round(value * scale) / scale;

export class Play extends Scene<GameState, undefined> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    part: "count-in",
    bpm: BPM,
    songBeat: 0,
    beatCount: 0,
    pulse: 0,
    lineIndex: 0,
    lineCount: LINES.length,
    lineBeat: 0,
    notes: [],
    called: 0,
    marks: [],
    matched: 0,
    lastGrade: "none",
    lastTiming: "none",
    lastCells: 0,
    cool: 0,
    good: 0,
    bad: 0,
    miss: 0,
    presses: 0,
    rung: 3,
    level: "good",
    freestyleOpen: 0,
    freestyle: 0,
    linesJudged: 0,
    lineScore: 0,
    lineThreshold: 0,
    message: "",
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for both performers: the combat mannequin (Quaternius' Universal Animation Library,
    // CC0), dressed apart by a material swap.
    this.#mannequin = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, undefined> {
    const mannequin = this.#mannequin;
    if (mannequin === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    let materialTier: QualityTier = "low";
    this.#post = setupPost(ctx.renderer, ctx.scene, camera, {
      onTierChanged: (tier) => {
        materialTier = tier;
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment));
      },
      godraysLight: lighting.key,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    const frameCamera = createStageCamera(camera);
    ctx.viewport.resize();

    const stage = ctx.entities.add("stage", new Stage());
    ctx.add(stage.mesh);
    // The teacher stands on the left and the player on the right, each turned a little toward the other.
    const teacher = ctx.entities.add(
      "teacher",
      new Performer(ctx, mannequin, { facing: 0.45, material: teacherMaterial, x: TEACHER_X }),
    );
    const player = ctx.entities.add(
      "player",
      new Performer(ctx, mannequin, { facing: -0.45, material: playerMaterial, x: PLAYER_X }),
    );
    const session = new Session();

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(materialTier, materialEnvironment),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const sample = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        sample.measurement,
        sample.source,
        sample.intensity,
        sample,
      );
    }

    let message = "";
    let messageTimer = 0;
    let lastGrade: GameState["lastGrade"] = "none";
    let lastTiming: GameState["lastTiming"] = "none";
    let lastCells = 0;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };

    /** What each event does to the stage: the teacher calls, the player answers, the rating moves. */
    const react = (event: SessionEvent): void => {
      if (event.kind === "call") {
        teacher.perform(event.button);
        emitPlaytestEvent({ button: event.button, entity: "teacher", name: "call" });
      } else if (event.kind === "press") {
        const { result } = event;
        if (result === undefined) player.perform(event.button);
        else {
          player.react(event.button, result.grade);
          lastGrade = result.grade;
          lastTiming = result.timing;
          lastCells = result.cells;
          if (result.freestyle) say("Freestyle");
          emitPlaytestEvent({
            entity: "player",
            grade: result.grade,
            name: "press",
            timing: result.timing,
          });
        }
      } else if (event.kind === "miss") {
        lastGrade = "miss";
        lastTiming = "none";
        lastCells = 0;
        player.react("left", "miss");
      } else if (event.kind === "line") {
        player.setMood(session.level);
        if (event.after < event.before) say("Rating up");
        else if (event.after > event.before) say("Rating down");
        emitPlaytestEvent({ entity: "player", name: "line", score: event.score.score });
      } else {
        player.setMood(session.level);
        if (event.outcome === "failed") player.fall();
        else player.perform("up");
        say(event.outcome === "cleared" ? "Stage clear" : "Stage failed");
        emitPlaytestEvent({ entity: "player", name: event.outcome });
      }
    };

    const frame: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      // The song starts once the startup compile has settled, so a slow launch never eats the count-in.
      const pressed = BUTTONS.filter(({ action }) => frameCtx.input.justPressed(action)).map(
        ({ name }) => name,
      );
      const events = session.update(frameCtx.startup.compileSettled ? dt : 0, pressed);
      for (const event of events) react(event);

      const pulse = session.clock.pulse;
      stage.update(pulse, session.clock.beat);
      frameCamera(pulse);
      teacher.update(dt, pulse);
      player.update(dt, pulse);

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      const beat = session.clock.beat;
      const { counts } = session;
      frame.phase = session.outcome;
      frame.part = session.part;
      // Floored, never rounded: a published beat may not run ahead of the beat the stage is drawn on.
      frame.songBeat = Math.floor(beat * 1000) / 1000;
      frame.beatCount = Math.floor(beat);
      frame.pulse = round(pulse, 100);
      frame.lineIndex = Math.min(session.line, LINES.length - 1);
      frame.lineBeat = round(session.lineBeat);
      frame.called = session.called;
      frame.matched = session.matched;
      frame.lastGrade = lastGrade;
      frame.lastTiming = lastTiming;
      frame.lastCells = round(lastCells, 10);
      frame.cool = counts.cool;
      frame.good = counts.good;
      frame.bad = counts.bad;
      frame.miss = counts.miss;
      frame.presses = counts.presses;
      frame.rung = session.rung;
      frame.level = session.level;
      frame.freestyleOpen = session.level === "cool" && session.outcome === "playing" ? 1 : 0;
      frame.freestyle = counts.freestyle;
      frame.linesJudged = session.linesJudged;
      frame.lineScore = session.lastScore === undefined ? 0 : round(session.lastScore.score, 100);
      frame.lineThreshold =
        session.lastScore === undefined ? 0 : round(session.lastScore.threshold, 100);
      frame.message = message;
      if (session.listsDirty) {
        frame.notes = session.notes.map(({ beat: noteBeat, button }) => ({
          beat: noteBeat,
          button,
        }));
        frame.marks = session.marks.slice();
        session.listsDirty = false;
      }
      frameCtx.state.set(frame);
    };
  }

  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
  }
}
