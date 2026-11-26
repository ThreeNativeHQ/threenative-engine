import { Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { IPhysicsContext } from "@threenative/physics";
import { MathUtils, type PerspectiveCamera } from "three";
import { CHAINS, type ISpace } from "../board/layout.js";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { PAWN_HALF, Pawn } from "../entities/Pawn.js";
import { drainIntents } from "../intents.js";
import { type IPlayer, Match, TURN_LIMIT } from "../match/turn.js";
import { Dash } from "../minigames/dash.js";
import { Rope } from "../minigames/rope.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { type IBoardView, SURFACE, createBoard } from "../render/board.js";
import { createCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import type { GameState, PlayerRow, TurnPhase } from "../state.js";
import { STATIONS, STATION_NAMES } from "../stations.js";

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

/** Pawns that share a space stand on a ring this wide, so no two stand inside each other. */
const SHARE_RADIUS = 0.55;
const MINIGAME_PHASES: ReadonlySet<TurnPhase> = new Set(["intro", "minigame", "result"]);

function row(player: IPlayer): PlayerRow {
  return {
    name: player.name,
    human: player.human ? 1 : 0,
    coins: player.coins,
    stars: player.stars,
    space: (CHAINS[player.cur.chain]?.ids[player.cur.slot] ?? 0) as number,
    chain: player.cur.chain,
    slot: player.cur.slot,
  };
}

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    time: 0,
    turn: 1,
    turnLimit: TURN_LIMIT,
    active: 0,
    turnPhase: "roll",
    die: 0,
    stepsLeft: 0,
    prompt: "",
    message: "",
    starSpace: 0,
    players: [],
    miniId: "",
    miniGo: 0,
    miniFalseStarts: 0,
    miniDone: 0,
    miniWinner: -1,
    miniAlive: [1, 1, 1, 1],
    ranking: [],
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for everyone: all four seats are the combat mannequin (Quaternius' Universal
    // Animation Library, CC0), dressed apart by a material swap.
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

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
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
    const rig = createCamera(camera);
    ctx.viewport.resize();

    const match = new Match(Math.floor(ctx.random() * 0x7fffffff));
    const board: IBoardView = createBoard(match.spaces);
    ctx.add(board.root);
    const pawns = match.players.map((player) => {
      const pawn = new Pawn(ctx, mannequin, player.seat);
      ctx.entities.add(player.human ? "player" : `cpu.${player.seat}`, pawn);
      return pawn;
    });

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

    let clock = 0;
    let matchTime = 0;
    // Back from the arena, the pawns cut to their spaces instead of gliding across the board.
    let wasInGame = false;
    let rowsSignature = "";
    const shared = new Map<number, number>();
    const frame: Partial<GameState> = {};
    // The pawn is where the rules put it. On a space it eases to its place on the shared ring.
    const placeOnBoard = (player: IPlayer, pawn: Pawn, dt: number, snap: boolean): void => {
      const space = match.spaceOf(player);
      const count = [...match.players].filter(
        (other) => !other.walking && match.spaceOf(other) === space,
      ).length;
      const order = shared.get(space.id) ?? 0;
      shared.set(space.id, order + 1);
      let ox = 0;
      let oz = 0;
      if (!player.walking && count > 1) {
        const angle = (order / count) * Math.PI * 2 + Math.PI / 4;
        ox = Math.sin(angle) * SHARE_RADIUS;
        oz = Math.cos(angle) * SHARE_RADIUS;
      }
      const ease = player.walking || snap ? 1 : Math.min(1, dt * 10);
      pawn.mesh.position.x += (player.x + ox - pawn.mesh.position.x) * ease;
      pawn.mesh.position.z += (player.z + oz - pawn.mesh.position.z) * ease;
      pawn.mesh.position.y = PAWN_HALF + SURFACE;
      const ahead = match.spaces[CHAINS[player.next.chain]?.ids[player.next.slot] ?? 0] as ISpace;
      const yaw = player.walking ? player.yaw : Math.atan2(ahead.x - player.x, ahead.z - player.z);
      pawn.face(yaw, dt);
      pawn.update(dt, player.walking ? "walk" : "idle");
    };

    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      clock += dt;
      if (UNDER_PLAYTEST)
        for (const name of STATION_NAMES) {
          if (!frameCtx.input.justPressed(name)) continue;
          STATIONS[name]?.(match);
          emitPlaytestEvent({ entity: "match", name });
        }
      const confirm = frameCtx.input.justPressed("confirm");
      let yes = confirm;
      let no = frameCtx.input.justPressed("decline");
      for (const intent of drainIntents()) {
        if (intent === "confirm") yes = true;
        if (intent === "decline") no = true;
      }
      if (frameCtx.startup.compileSettled) {
        matchTime += dt;
        if (yes) match.confirm();
        if (no) match.decline();
        match.update(dt, { jump: confirm, run: frameCtx.input.vector("move").x });
      }
      for (const event of match.events.splice(0)) {
        emitPlaytestEvent({
          entity: "match",
          name: event.name,
          seat: event.seat,
          value: event.value,
        });
        const pawn = pawns[event.seat];
        if (event.name === "roll") pawn?.gesture("roll", 0.8);
        if (event.name === "star") pawn?.gesture("cheer", 1.2);
      }

      const game = match.minigame;
      const inGame = game !== undefined && MINIGAME_PHASES.has(match.phase);
      shared.clear();
      for (const [seat, pawn] of pawns.entries()) {
        const player = match.players[seat] as IPlayer;
        const body = inGame ? game.contestants[seat] : undefined;
        if (body === undefined) {
          placeOnBoard(player, pawn, dt, wasInGame);
          continue;
        }
        pawn.mesh.position.set(body.x, PAWN_HALF + body.y + 0.01, body.z);
        pawn.face(body.yaw, dt);
        pawn.update(dt, body.pose);
      }
      wasInGame = inGame;
      const active = match.current;
      board.sync(match.spaces);
      board.showMinigame(inGame ? game.id : "", game instanceof Dash && game.go);
      if (game instanceof Rope) board.bar.rotation.y = -game.angle;
      rig.follow(active.x, active.z, inGame, dt);

      // The die tumbles over the pawn that is rolling.
      board.die.visible = match.phase === "rolling";
      if (board.die.visible) {
        board.die.position.set(active.x, 3 + Math.abs(Math.sin(clock * 6)) * 0.5, active.z);
        board.die.rotation.set(clock * 9, clock * 7, clock * 5);
      }
      // The star floats over the live space. Sold, it lifts, then arcs to the buyer and spins.
      const live = match.spaces[match.star.space] as ISpace;
      const bob = Math.sin(clock * 2) * 0.12;
      if (match.phase === "award") {
        // Lift then travel with a sine arc. mario-party-1 `star-purchase` (298AE0.c:291): 200 units
        // up and a 100 unit arc, here 2 m and 1 m (one grid unit is 5 units there and 3 m here).
        const t = match.beat;
        board.star.position.set(
          MathUtils.lerp(live.x, active.x, t),
          SURFACE + 2 + t * 0.8 + Math.sin(t * Math.PI),
          MathUtils.lerp(live.z, active.z, t),
        );
        board.star.rotation.y = clock * 8;
      } else {
        board.star.position.set(live.x, SURFACE + 1.7 + bob, live.z);
        board.star.rotation.y = clock * 1.4;
      }

      frame.phase = match.phase !== "over" ? "playing" : match.ranking[0] === 0 ? "won" : "lost";
      frame.time = Math.round(matchTime * 10) / 10;
      frame.turn = match.turn;
      frame.active = match.active;
      frame.turnPhase = match.phase;
      frame.die = match.die;
      frame.stepsLeft = match.stepsLeft;
      frame.prompt = match.current.human ? match.prompt : "";
      frame.message = match.message;
      frame.starSpace = match.star.space;
      const rows = match.players.map((player) => row(player));
      const signature = JSON.stringify(rows);
      if (signature !== rowsSignature) {
        rowsSignature = signature;
        frame.players = rows;
      }
      frame.miniId = inGame ? game.id : "";
      frame.miniGo = game instanceof Dash && game.go ? 1 : 0;
      frame.miniFalseStarts = game instanceof Dash ? game.falseStarts : 0;
      frame.miniDone = game?.done ? 1 : 0;
      frame.miniWinner = game?.winner ?? -1;
      const alive = game instanceof Rope ? game.alive.map((up) => (up ? 1 : 0)) : [1, 1, 1, 1];
      if (alive.join() !== (frame.miniAlive ?? []).join()) frame.miniAlive = alive;
      if (match.ranking !== frame.ranking) frame.ranking = match.ranking;
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
