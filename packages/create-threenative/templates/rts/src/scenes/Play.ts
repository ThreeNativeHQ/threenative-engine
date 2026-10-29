import {
  type ICtx,
  type IRawInputPointerEdge,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
  lodPixelScale,
} from "@threenative/core";
import { Object3D, type OrthographicCamera, type Texture, Vector2, Vector3 } from "three";
import { onSceneIntent } from "../orders.js";
import { createArmy } from "../render/army.js";
import {
  EDGE,
  type IRtsView,
  applyRtsCamera,
  createRtsView,
  focusRts,
  groundAt,
  panRts,
  panSpeed,
  zoomRts,
} from "../render/camera.js";
import { createEnvironment } from "../render/environment.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { type ISun, setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { createUnitModels } from "../render/models.js";
import {
  DRAG_SLOP,
  type PickTarget,
  dragBoxRect,
  pickEntity,
  unitsInBox,
} from "../render/picking.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { createResources } from "../render/resources.js";
import { setupSky } from "../render/sky.js";
import { createTerrain } from "../render/terrain.js";
import { Game } from "../sim/game.js";
import { HALF, WORLD, terrainHeight } from "../sim/terrain.js";
import {
  type BuildingType,
  type EntityType,
  type ICommandTarget,
  type IEntity,
  type IPoint,
  type IResourceNode,
  SIM_STEP,
  TYPES,
  dist,
} from "../sim/types.js";
import { type GameState, INITIAL_STATE } from "../state.js";

export type GameCtx = ICtx<GameState, undefined>;

/** The engine ticks at 60 Hz; the rules advance on their own 0.05 s clock, collected here. */
const STEP = SIM_STEP;
/** Never run more than a quarter second of catch-up: a tab that was backgrounded must not spend a
 * second of catch-up stalling the frame it came back on. */
const MAX_CATCH_UP = 0.25;
/** The coarse fog raster the HUD draws: 28 cells over 224 m is one every 8 m. */
const MINIMAP = 28;
/** Every order the panel can name, in the order the readout lists them. */
const ORDER_KINDS = [
  "attack",
  "attackMove",
  "construct",
  "gather",
  "garrison",
  "heal",
  "hold",
  "idle",
  "move",
  "repair",
] as const;

const REFUSALS: Readonly<Record<string, string>> = {
  attack: "Those units cannot attack that target. Check the air and ground tables.",
  attackMove: "Those units cannot advance under fire.",
  garrison: "Select Vanguards and a friendly bunker with free slots.",
  repair: "Select a Surveyor and a completed friendly structure.",
};

/** One drag, one canvas pointer. Reused, because a drag is a press, a move and a release. */
interface IDrag {
  from: Vector2;
  id: number;
  to: Vector2;
}

/**
 * The selection's own anchor, registered with the playtest bridge.
 *
 * The entities themselves are instanced: one `Object3D` holds sixty tanks and its position is none
 * of theirs. So the scene publishes a handle on the selection — its size, the orders it holds and
 * the centroid it stands at — and a scenario reads a real world position and a real order off it.
 * It is not a test-only object: the panel's position readout is the same number.
 */
class SelectionAnchor {
  readonly object = new Object3D();
  count = 0;
  order = "";

  debug(): Record<string, number | string> {
    return {
      count: this.count,
      order: this.order,
      x: Math.round(this.object.position.x * 100) / 100,
      z: Math.round(this.object.position.z * 100) / 100,
    };
  }
}

export class Play extends Scene<GameState, undefined> {
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #materialEnvironment(ctx: GameCtx) {
    return {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
  }
  static override readonly initialState: GameState = INITIAL_STATE;

  #sky: Texture | undefined;
  #sim: Game | undefined;
  #view: IRtsView | undefined;
  #sun: ISun | undefined;
  #terrain: ReturnType<typeof createTerrain> | undefined;
  #army: ReturnType<typeof createArmy> | undefined;
  #resources: ReturnType<typeof createResources> | undefined;
  #models: ReturnType<typeof createUnitModels> | undefined;
  #selection: number[] = [];
  #selected = new Set<number>();
  #anchor = new SelectionAnchor();
  #drag: IDrag | undefined;
  #box: number[] = [0, 0, 0, 0];
  /** The pointer position the band's live count was taken at, so a still pointer rescans nothing. */
  #boxAt = new Vector2(Number.NaN, Number.NaN);
  #found: number[] = [];
  #kinds = new Uint8Array(ORDER_KINDS.length);
  #mode = "";
  #pointerSeen = false;
  #accumulator = 0;
  /** The engine tick the rules clock is fed in, and the camera position before the latest one. */
  #tick = 0;
  #eyeFrom = new Vector3();
  #eye = new Vector3();
  #drawnAt = -1;
  #stopDraw: (() => void) | undefined;
  #minimapDirty = true;
  #publishedStep = -1;
  #notice = "";
  #fogText = "";
  #dots: number[] = [];
  #viewCorners: number[] = [];
  #patch: Partial<GameState> = {};
  /** Game speed the HUD's speed button cycles: 1×, 1.5×, 2×. */
  #speed = 1;
  /** Control groups 1-5, set and recalled from the HUD; `#groupCounts` is what it shows. */
  #groups: number[][] = [[], [], [], [], []];
  #groupCounts: number[] = [0, 0, 0, 0, 0];
  /** Selection signature the roster was last built for, so a click while paused still updates it. */
  #rosterSignature = -1;
  #contacts = new Uint16Array(3);
  #rivals: string[] = ["NO CONTACT", "NO CONTACT"];

  override async load(ctx: GameCtx): Promise<void> {
    this.#sky = await ctx.assets.texture("sky.jpg");
    setupSky(ctx.scene, this.#sky);
    this.#environmentSample = await sampleEnvironment(
      ctx.renderer.raw,
      ctx.scene,
      this.#materialEnvironment(ctx),
    );
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, undefined> {
    if (this.#sky === undefined) throw new Error("Play.enter ran before load() loaded sky.jpg.");
    const camera = ctx.camera as OrthographicCamera;
    // The world is seeded from the engine's own stream rather than from a constant, so two
    // projects built from this template open on different maps — and one project's map is still
    // reproducible from the `seed` in src/game.ts.
    const sim = new Game({ seed: Math.floor(ctx.random.range(1, 1_000_000)) });
    this.#sim = sim;
    const view = createRtsView(-70, 58);
    this.#view = view;

    setupSky(ctx.scene, this.#sky);
    const sun = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    this.#sun = sun;
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code, exactly like createRandom.
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: sun.key,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(
          materialLightingEnabled(tier, this.#materialEnvironment(ctx)),
        ),
    });
    const loading = createLoadingScreen(ctx);
    this.#terrain = createTerrain();
    this.#models = createUnitModels();
    this.#army = createArmy(this.#models, {
      added: (mesh) => this.#materialLighting?.enroll(mesh),
      removed: (mesh) => this.#materialLighting?.release(mesh),
    });
    this.#resources = createResources();
    const world = new Object3D();
    world.add(
      this.#terrain.root,
      createEnvironment(sim).root,
      this.#resources.root,
      this.#army.root,
      this.#anchor.object,
    );
    ctx.add(world);
    ctx.entities.add("selection", this.#anchor);
    applyRtsCamera(camera, view, ctx.viewport.size, STEP);
    // The commander opens on their own base with their army already selected: a strategy game that
    // starts with an empty selection teaches the click by making the player guess.
    this.#selectIds(sim.army().map((entity) => entity.id));
    onSceneIntent((intent, payload) => this.#intent(intent, payload));

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, sun.key, {
        ...this.#materialEnvironment(ctx),
        enabled: materialLightingEnabled(this.#post.tier, this.#materialEnvironment(ctx)),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const { measurement, source, intensity } = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        measurement,
        source,
        intensity,
        this.#environmentSample,
      );
    }

    // The army is drawn once per rendered frame, after the frame's last tick, between the rules'
    // last two steps: the rules move units 20 times a second and the screen shows 60.
    this.#eyeFrom.copy(camera.position);
    this.#stopDraw = ctx.beforeRender(() => this.#draw(ctx, sim, camera));

    return (frameCtx, dt) => {
      loading.update();
      this.#tick = dt;
      this.#eyeFrom.copy(camera.position);
      this.#readInput(frameCtx, dt);
      this.#accumulator = Math.min(this.#accumulator + dt * this.#speed, MAX_CATCH_UP);
      while (this.#accumulator >= STEP) {
        this.#army?.step(sim);
        sim.update(STEP);
        this.#accumulator -= STEP;
      }
      this.#drain(sim);
      this.#prune(sim);
      applyRtsCamera(camera, view, frameCtx.viewport.size, dt);
      sun.follow(view.target.x, view.target.z, camera);
      if (this.#minimapDirty) {
        this.#minimapDirty = false;
        this.#terrain?.updateFog(sim);
        this.#resources?.sync(sim);
        this.#minimap(sim);
      }
      this.#publish(frameCtx, sim, view);
    };
  }

  /**
   * Write the army for the frame about to be drawn. The engine draws the camera between its last two
   * ticks (`ctx.alpha`), so the units are drawn at the same moment on the rules' clock, and the bars
   * are snapped against the camera position the frame really uses. A paused game draws the latest
   * state, as the engine does.
   */
  #draw(ctx: GameCtx, sim: Game, camera: OrthographicCamera): void {
    const now = ctx.frameTime;
    const dt = this.#drawnAt < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.#drawnAt) / 1000));
    this.#drawnAt = now;
    const alpha = ctx.state.getState().paused ? 1 : ctx.alpha;
    const ahead = this.#accumulator + alpha * this.#tick * this.#speed;
    const blend = Math.min(1, ahead / STEP);
    this.#eye.lerpVectors(this.#eyeFrom, camera.position, alpha);
    this.#army?.sync(
      sim,
      this.#selected,
      sim.time - STEP + blend * STEP,
      dt,
      camera,
      lodPixelScale(camera, ctx.viewport.size.height, 1),
      blend,
      this.#eye,
    );
  }

  override exit(ctx: GameCtx): void {
    this.#stopDraw?.();
    this.#stopDraw = undefined;
    this.#drawnAt = -1;
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;

    onSceneIntent(() => undefined);
    ctx.entities.remove("selection");
    this.#army?.dispose();
    this.#models?.dispose();
    this.#resources?.dispose();
    this.#army = undefined;
    this.#models = undefined;
    this.#resources = undefined;
    this.#terrain = undefined;
    this.#sun = undefined;
    this.#sim = undefined;
    this.#view = undefined;
    this.#selection = [];
    this.#selected.clear();
    this.#drag = undefined;
    this.#mode = "";
    super.exit(ctx);
  }

  // ---------------------------------------------------------------- input

  /**
   * Everything the pointer and the keys do, read through `ctx.input` bindings and nothing else.
   *
   * One pass, at the top of the frame: a gesture becomes an intent against the state the last
   * frame drew, and a held key or the wheel applies on the step that follows. No `src/render/`
   * file and no listener outside `src/main.ts` and `src/ui/` is involved.
   */
  #readInput(ctx: GameCtx, dt: number): void {
    const sim = this.#sim;
    const view = this.#view;
    if (sim === undefined || view === undefined) return;
    const size = ctx.viewport.size;
    const raw = ctx.input.raw;
    const keys = raw.keys;

    const pan = ctx.input.vector("move");
    const speed = panSpeed(view) * dt;
    if (pan.x !== 0 || pan.y !== 0) panRts(view, pan.x * speed, -pan.y * speed);
    // The pointer reads (0, 0) until the surface has seen one, and (0, 0) is the top-left corner.
    // Scrolling on that is how a strategy game opens with the camera already at the map edge
    // because nobody has touched the mouse yet.
    const at = raw.pointer.position;
    if (at.x !== 0 || at.y !== 0) this.#pointerSeen = true;
    // Edge scroll: the cursor within `EDGE` pixels of the frame pans, but never while it is
    // pressing something — a drag that reached the edge was a drag, not a scroll.
    if (this.#pointerSeen && raw.pointer.buttons === 0 && this.#drag === undefined) {
      if (at.x < EDGE) panRts(view, -speed, 0);
      else if (at.x > size.width - EDGE) panRts(view, speed, 0);
      else if (at.y < EDGE) panRts(view, 0, -speed);
      else if (at.y > size.height - EDGE) panRts(view, 0, speed);
    }
    // The axis is positive for a scroll up (negative DOM deltaY), which zooms in: a smaller view.
    const zoom = ctx.input.axis("zoom");
    if (zoom !== 0) zoomRts(view, -zoom);

    if (this.#drag !== undefined) {
      const live = raw.pointers.get(this.#drag.id);
      if (live !== undefined) this.#drag.to.copy(live.position);
    }
    for (const edges of raw.pointerEdges.values())
      for (const edge of edges) {
        if (edge.type !== "down") {
          this.#release(ctx, edge, isShifted(keys));
        } else if ((edge.buttons & 2) !== 0) {
          this.#orderAt(ctx, edge.position, isShifted(keys));
        } else if (this.#mode === "") {
          // A press while a mode is armed is that order, not a band: the banner says CLICK, and a
          // box drawn under an attack-move is a gesture that cannot do what it looks like.
          this.#drag = { from: edge.position.clone(), id: edge.id, to: edge.position.clone() };
        }
      }

    if (ctx.input.justPressed("cancel")) this.#mode = "";
    if (ctx.input.justPressed("army")) this.#selectIds(sim.army().map((entity) => entity.id));
    if (ctx.input.justPressed("base")) this.#focusBase(sim);
    if (ctx.input.justPressed("attack")) this.#mode = "attack";
    if (ctx.input.justPressed("moveOrder")) this.#mode = "move";
    if (ctx.input.justPressed("hold")) sim.command(this.#selection, "hold");
    if (ctx.input.justPressed("stopOrder")) sim.command(this.#selection, "stop");
  }

  /** A release: the armed order if there is one, otherwise the band the press opened. */
  #release(ctx: GameCtx, edge: IRawInputPointerEdge, shift: boolean): void {
    const sim = this.#sim;
    const view = this.#view;
    if (sim === undefined || view === undefined) return;
    if (this.#mode !== "") {
      // A cancel is not a click: a mode survives the pointer leaving, as it does in AstraCraft.
      if (edge.type === "up") this.#orderAt(ctx, edge.position, shift);
      return;
    }
    const drag = this.#drag;
    if (drag === undefined || drag.id !== edge.id) return;
    this.#drag = undefined;
    const camera = ctx.camera as OrthographicCamera;
    const size = ctx.viewport.size;
    const at = edge.position;
    if (Math.hypot(at.x - drag.from.x, at.y - drag.from.y) <= DRAG_SLOP) {
      const hit = pickEntity(sim, camera, view, size, at.x, at.y);
      if (hit === undefined) {
        if (!shift) this.#selectIds([]);
        return;
      }
      this.#toggleSelection(hit, shift);
      return;
    }
    // Shift adds to what is selected; a fresh drag replaces it.
    const keep = shift ? this.#selection.filter((id) => sim.get(id)?.team === 0) : [];
    unitsInBox(sim, camera, view, size, drag.from, drag.to, isAlt(ctx.input.raw.keys), this.#found);
    this.#selectIds(keep.concat(this.#found));
  }

  #toggleSelection(hit: PickTarget, additive: boolean): void {
    const sim = this.#sim;
    if (sim === undefined || hit === undefined) return;
    if (!additive) {
      this.#selectIds([hit.id]);
      return;
    }
    if (hit.team !== 0) return;
    this.#selectIds(
      this.#selected.has(hit.id)
        ? this.#selection.filter((id) => id !== hit.id)
        : this.#selection.concat(hit.id),
    );
  }

  #orderAt(ctx: GameCtx, at: Vector2, append: boolean): void {
    const sim = this.#sim;
    const view = this.#view;
    if (sim === undefined || view === undefined) return;
    const camera = ctx.camera as OrthographicCamera;
    if (this.#mode.startsWith("build:")) {
      const ground = groundAt(camera, at.x, at.y, ctx.viewport.size);
      if (ground === null) return;
      const type = this.#mode.slice(6) as BuildingType;
      const result = sim.build(type, ground.x, ground.z, 0);
      if (!result.ok) {
        this.#notice = result.message ?? "That site cannot be built there.";
        return;
      }
      this.#notice = `${TYPES[type].name} ordered. Its Surveyor must stay on site.`;
      this.#army?.marker(ground.x, ground.z, false);
      this.#mode = "";
      return;
    }
    if (this.#selection.length === 0) return;
    const ground = groundAt(camera, at.x, at.y, ctx.viewport.size);
    if (ground === null) return;
    const hit = pickEntity(sim, camera, view, ctx.viewport.size, at.x, at.y);
    const choice = this.#contextual(sim, ground, hit);
    const result = sim.command(this.#selection, choice.kind, choice.target, 0, append);
    if (!result.ok) {
      this.#notice = REFUSALS[choice.kind] ?? "No selected unit can do that.";
      return;
    }
    this.#notice = "";
    this.#army?.marker(
      ground.x,
      ground.z,
      choice.kind === "attack" || choice.kind === "attackMove",
    );
    this.#mode = "";
  }

  /**
   * What a right-click means: whatever is under the cursor that the selection can actually do,
   * and a plain move otherwise. The order of the tests is the order of what a commander means —
   * kill this, enter that bunker, patch this wall, mine that field, walk over there.
   */
  #contextual(
    sim: Game,
    ground: IPoint,
    hit: PickTarget,
  ): { readonly kind: string; readonly target: ICommandTarget } {
    const mode = this.#mode;
    const move = { kind: "move", target: ground } as const;
    if (mode === "attack")
      return hit !== undefined && hit.team > 0
        ? { kind: "attack", target: { id: hit.id } }
        : { kind: "attackMove", target: ground };
    if (mode === "rally" || mode === "move") return move;
    if (mode === "garrison" || mode === "repair") return { kind: mode, target: { id: hit?.id } };
    if (hit !== undefined && hit.team > 0) return { kind: "attack", target: { id: hit.id } };
    const has = (type: EntityType) => this.#selection.some((id) => sim.get(id)?.type === type);
    if (hit !== undefined && hit.team === 0 && hit.type === "bunker" && has("ranger"))
      return { kind: "garrison", target: { id: hit.id } };
    if (
      hit !== undefined &&
      hit.team === 0 &&
      hit.building &&
      hit.hp < hit.maxHp - 0.1 &&
      has("worker")
    )
      return { kind: "repair", target: { id: hit.id } };
    const node = nodeNear(sim, ground.x, ground.z);
    if (node !== undefined && has("worker")) return { kind: "gather", target: { id: node.id } };
    return move;
  }

  /**
   * A UI button, or a key that only names a mode. One door, so the two can never disagree about
   * what "retreat" or "place a Skyport" means.
   */
  #intent(intent: string, payload?: unknown): void {
    const sim = this.#sim;
    if (sim === undefined) return;
    const value = typeof payload === "string" ? payload : "";
    switch (intent) {
      case "army":
        this.#selectIds(sim.army().map((entity) => entity.id));
        break;
      case "base":
        this.#focusBase(sim);
        break;
      case "order":
        this.#mode = value;
        break;
      case "place":
        this.#mode = `build:${value}`;
        break;
      case "cancel":
        this.#mode = "";
        break;
      case "train": {
        const producer = this.#primary();
        const result =
          producer === undefined
            ? { ok: false, message: "Select a production building first." }
            : sim.train(producer.id, value as EntityType);
        this.#notice = result.ok
          ? `${TYPES[value as EntityType].name} queued.`
          : (result.message ?? "That cannot be trained here.");
        break;
      }
      case "cancelTrain": {
        const producer = this.#primary();
        if (producer !== undefined)
          sim.cancelTrain(
            producer.id,
            producer.queue.findIndex((item) => item.type === value),
          );
        break;
      }
      case "retreat": {
        const core = sim.own().find((entity) => entity.type === "core" && entity.built);
        if (core !== undefined) {
          sim.command(this.#selection, "move", { x: core.x + 9, z: core.z + 8 });
          this.#army?.marker(core.x + 9, core.z + 8, false);
        }
        break;
      }
      case "hold":
      case "stop":
        sim.command(this.#selection, intent);
        break;
      case "idle": {
        const idle = sim
          .own()
          .filter((entity) => entity.type === "worker" && entity.order.kind === "idle");
        this.#selectIds(idle.map((entity) => entity.id));
        const first = idle[0];
        if (first !== undefined && this.#view !== undefined) focusRts(this.#view, first.x, first.z);
        this.#notice =
          idle.length > 0
            ? `${idle.length} idle Surveyors selected.`
            : "All Surveyors are working.";
        break;
      }
      case "select":
        this.#selectIds([Number(value)]);
        break;
      case "group": {
        // "3" recalls group 3 (or sets it while it is empty), "set:3" always sets it.
        const assign = value.startsWith("set:");
        const index = Number(assign ? value.slice(4) : value) - 1;
        const group = this.#groups[index];
        if (group === undefined) break;
        if (assign || group.length === 0)
          this.#groups[index] = this.#selection.filter((id) => sim.get(id)?.team === 0);
        else this.#selectIds(group.filter((id) => sim.get(id) !== undefined));
        break;
      }
      case "speed":
        this.#speed = this.#speed === 1 ? 1.5 : this.#speed === 1.5 ? 2 : 1;
        break;
      case "cancelBuild": {
        const site = this.#primary();
        if (site === undefined || site.team !== 0 || site.built) break;
        const result = sim.cancelBuild(site.id);
        this.#notice = result.ok
          ? "Construction cancelled. 75% refunded."
          : (result.message ?? "That site cannot be cancelled.");
        break;
      }
      default:
        break;
    }
  }

  #focusBase(sim: Game): void {
    const core = sim.own().find((entity) => entity.type === "core");
    if (core !== undefined && this.#view !== undefined)
      focusRts(this.#view, core.x + 2, core.z - 6);
  }

  #selectIds(ids: readonly number[]): void {
    this.#selection = [...ids];
    this.#selected.clear();
    for (const id of this.#selection) this.#selected.add(id);
  }

  #primary(): IEntity | undefined {
    const sim = this.#sim;
    if (sim === undefined) return undefined;
    for (const id of this.#selection) {
      const entity = sim.get(id);
      if (entity !== undefined) return entity;
    }
    return undefined;
  }

  // --------------------------------------------------------------- events

  /** Anything the selection lost, or anything it gained sight of, changes what may be ordered. */
  #prune(sim: Game): void {
    let dropped = false;
    for (const id of this.#selection) {
      const entity = sim.get(id);
      if (entity === undefined || (entity.team > 0 && !sim.visibleAt(entity.x, entity.z))) {
        this.#selected.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.#selection = this.#selection.filter((id) => this.#selected.has(id));
  }

  #drain(sim: Game): void {
    for (const event of sim.drainEvents()) {
      const team = Number(event.team ?? -1);
      if (event.type === "trained" && team === 0) this.#notice = `${String(event.name)} ready.`;
      else if (event.type === "complete" && team === 0)
        this.#notice = `${String(event.name)} online.`;
      else if (event.type === "eliminated" && team > 0)
        this.#notice = `${String(event.name)} command network destroyed.`;
      else if (event.type === "constructionLost" && team === 0)
        this.#notice = `${String(event.name)}: ${String(event.reason)}`;
      else if (event.type === "end") this.#notice = "";
    }
  }

  // ---------------------------------------------------------------- state

  /**
   * The published state: cheap numbers every frame, and the two derived views — the queue and the
   * tactical overview — on the simulation's own clock, because both are lists and a list rebuilt
   * sixty times a second to change by a hundredth is the allocation this scene is avoiding.
   */
  #publish(ctx: GameCtx, sim: Game, view: IRtsView): void {
    const primary = this.#primary();
    this.#kinds.fill(0);
    let count = 0;
    let teams = 0;
    let x = 0;
    let z = 0;
    let hp = 0;
    let maxHp = 0;
    let airborne = 0;
    let signature = 0;
    for (const id of this.#selection) {
      const entity = sim.get(id);
      if (entity === undefined || entity.garrisonId !== null) continue;
      count += 1;
      hp += Math.ceil(entity.hp);
      maxHp += entity.maxHp;
      if (entity.air) airborne += 1;
      signature = (signature * 31 + id) | 0;
      teams |= 1 << entity.team;
      x += entity.x;
      z += entity.z;
      const kind = ORDER_KINDS.indexOf(entity.order.kind as (typeof ORDER_KINDS)[number]);
      if (kind >= 0) this.#kinds[kind] = 1;
    }
    if (count > 0) {
      x /= count;
      z /= count;
      this.#anchor.object.position.set(x, terrainHeight(x, z), z);
    }
    this.#anchor.count = count;
    this.#anchor.order = ORDER_KINDS.filter((_, index) => this.#kinds[index] === 1).join(",");

    const supply = sim.supply(0);
    const patch = this.#patch;
    patch.cameraX = Math.round(view.target.x * 10) / 10;
    patch.cameraZoom = Math.round(view.zoom * 10) / 10;
    patch.cameraZ = Math.round(view.target.z * 10) / 10;
    patch.gathered = sim.gathered;
    patch.gas = Math.floor(sim.resources.gas);
    patch.kills = sim.kills;
    patch.mode = this.#mode;
    patch.ore = Math.floor(sim.resources.ore);
    patch.primaryBuilt = primary?.built ?? true;
    // Whole points, rounded up: the readout never shows a fraction or a living unit at 0.
    patch.primaryHp = Math.ceil(primary?.hp ?? 0);
    patch.primaryMaxHp = primary?.maxHp ?? 0;
    patch.primaryProgress = primary?.progress ?? 0;
    patch.primaryTeam = primary?.team ?? 0;
    patch.primaryType = primary?.type ?? "";
    patch.result = sim.result ?? "";
    patch.selection = count;
    patch.selectionOrder = this.#anchor.order;
    patch.selectionTeams = countBits(teams);
    patch.selectionX = Math.round(x * 100) / 100;
    patch.selectionZ = Math.round(z * 100) / 100;
    patch.simTime = Math.floor(sim.time * 20);
    patch.supplyCap = supply.cap;
    patch.supplyUsed = supply.used;
    patch.groupHp = hp;
    patch.groupMaxHp = maxHp;
    patch.airborne = airborne;
    patch.speed = this.#speed;
    for (let index = 0; index < 5; index += 1)
      this.#groupCounts[index] = this.#groups[index]?.length ?? 0;
    patch.groups = this.#groupCounts;
    const stepped = this.#publishedStep !== Math.floor(sim.time * 20);
    if (stepped || this.#rosterSignature !== signature) {
      this.#rosterSignature = signature;
      this.#roster(sim, patch);
    }
    if (this.#drag === undefined) {
      patch.dragBox = null;
    } else {
      const rect = dragBoxRect(this.#drag.from, this.#drag.to);
      // Mutated in place: the store holds the reference and the bridge clones at the boundary, so
      // a rubber band does not allocate a fresh array on every frame it is being dragged.
      if (rect === null) {
        patch.dragBox = null;
      } else {
        this.#box[0] = rect[0];
        this.#box[1] = rect[1];
        this.#box[2] = rect[2];
        this.#box[3] = rect[3];
        patch.dragBox = this.#box;
        // What a release right now would take, from the scan that release runs: the badge cannot
        // promise a number the selection does not deliver. Only while the pointer is moving.
        const to = this.#drag.to;
        if (this.#boxAt.x !== to.x || this.#boxAt.y !== to.y) {
          this.#boxAt.copy(to);
          patch.dragCount = unitsInBox(
            sim,
            ctx.camera as OrthographicCamera,
            view,
            ctx.viewport.size,
            this.#drag.from,
            to,
            isAlt(ctx.input.raw.keys),
            this.#found,
          ).length;
        }
      }
    }
    if (stepped) {
      this.#publishedStep = Math.floor(sim.time * 20);
      this.#commanders(sim, patch);
      // The fog texture and the overview are rebuilt on the simulation's clock, not the frame's:
      // a fog raster is 784 cells and a contact is a quad, and neither moves faster than the
      // rules that move it.
      this.#minimapDirty = true;
      patch.minimapDots = this.#dots;
      patch.minimapFog = this.#fogText;
      patch.notice = this.#notice;
      patch.queue = (primary?.queue ?? []).map(
        (item) => `${item.type}:${item.progress.toFixed(2)}`,
      );
    }
    // The view follows the camera every frame, paused or not, but is republished only when it moved.
    if (this.#viewQuad(ctx.camera as OrthographicCamera, ctx.viewport.size))
      patch.minimapView = this.#viewCorners;
    ctx.state.set(patch);
  }

  /** The selection card's roster (`"<id>:<type>:<hp tenths>"`, first 16) and its distinct types. */
  #roster(sim: Game, patch: Partial<GameState>): void {
    const roster: string[] = [];
    const types: string[] = [];
    for (const id of this.#selection) {
      const entity = sim.get(id);
      if (entity === undefined || entity.garrisonId !== null) continue;
      if (!types.includes(entity.type)) types.push(entity.type);
      if (roster.length < 16)
        roster.push(`${id}:${entity.type}:${Math.ceil((entity.hp / entity.maxHp) * 10)}`);
    }
    patch.roster = roster;
    patch.selectionTypes = types;
  }

  /** The objective panel and the rival-commanders panel, on the simulation's clock. */
  #commanders(sim: Game, patch: Partial<GameState>): void {
    const contacts = this.#contacts;
    contacts.fill(0);
    let skyport = false;
    let air = 0;
    let idle = 0;
    for (const entity of sim.entities) {
      if (entity.hp <= 0 || entity.garrisonId !== null) continue;
      if (entity.team > 0) {
        if (sim.visibleAt(entity.x, entity.z))
          contacts[entity.team] = (contacts[entity.team] ?? 0) + 1;
      } else if (entity.type === "starport" && entity.built) skyport = true;
      else if (entity.air) air += 1;
      else if (entity.type === "worker" && entity.order.kind === "idle") idle += 1;
    }
    let defeated = 0;
    for (let team = 1; team <= 2; team += 1) {
      const seen = contacts[team] ?? 0;
      const out = sim.players[team]?.eliminated === true;
      if (out) defeated += 1;
      this.#rivals[team - 1] = out ? "DEFEATED" : seen > 0 ? `${seen} CONTACTS` : "NO CONTACT";
    }
    patch.rivals = this.#rivals;
    patch.defeated = defeated;
    patch.skyport = skyport;
    patch.airWing = air;
    patch.idleWorkers = idle;
  }

  /**
   * The ground under the frame's four corners, in the minimap's units (tenths of a raster cell):
   * an orthographic camera at a pitch sees a slanted quad of map, not a square. True when it moved.
   */
  #viewQuad(camera: OrthographicCamera, size: { height: number; width: number }): boolean {
    const scale = (MINIMAP / WORLD) * 10;
    const view: number[] = [];
    for (const [sx, sy] of [
      [0, 0],
      [size.width, 0],
      [size.width, size.height],
      [0, size.height],
    ] as const) {
      const ground = groundAt(camera, sx, sy, size);
      if (ground === null) return false;
      view.push(Math.round((ground.x + HALF) * scale), Math.round((ground.z + HALF) * scale));
    }
    if (view.every((value, index) => value === this.#viewCorners[index])) return false;
    this.#viewCorners = view;
    return true;
  }

  /**
   * The tactical overview: one character per cell of a coarse fog raster, then one quad per
   * contact. Rebuilt on the simulation's clock rather than per frame — a map is a map, and the
   * units on it move metres a second, not pixels.
   */
  #minimap(sim: Game): void {
    const size = sim.gridSize;
    const cell = Math.max(1, Math.floor(size / MINIMAP));
    let fog = "";
    const dots: number[] = [];
    for (let row = 0; row < MINIMAP; row += 1) {
      for (let column = 0; column < MINIMAP; column += 1) {
        const index = (row * cell + (cell >> 1)) * size + (column * cell + (cell >> 1));
        fog += sim.visible[index] === 1 ? "#" : sim.explored[index] === 1 ? "," : ".";
      }
    }
    const scale = (MINIMAP / WORLD) * 10;
    const put = (x: number, z: number, team: number, kind: number) =>
      dots.push(Math.round((x + HALF) * scale), Math.round((z + HALF) * scale), team, kind);
    for (const entity of sim.entities) {
      if (entity.garrisonId !== null) continue;
      if (entity.team > 0 && !sim.visibleAt(entity.x, entity.z)) continue;
      put(entity.x, entity.z, entity.team, entity.building ? 1 : 0);
    }
    for (const node of sim.nodes) {
      if (node.amount <= 0) continue;
      const index = cellIndex(sim, node.x, node.z);
      if (index < 0 || sim.explored[index] !== 1) continue;
      put(node.x, node.z, 9, node.kind === "ore" ? 2 : 3);
    }
    this.#fogText = fog;
    this.#dots = dots;
  }
}

/**
 * The ore or gas under a point, if any.
 *
 * The reach is the field's own footprint, not one crystal's: an ore node is seven cones on a 4.4 m
 * ring, so a click has to land on the deposit rather than on a 1.6 m rock inside it. A click
 * anywhere within a couple of metres of the site's centre lands on one of the seven.
 */
function nodeNear(sim: Game, x: number, z: number): IResourceNode | undefined {
  for (const node of sim.nodes) {
    if (node.amount <= 0 || !sim.visibleAt(node.x, node.z)) continue;
    if (dist(node, { x, z }) < node.r + 3.5) return node;
  }
  return undefined;
}

function cellIndex(sim: Game, x: number, z: number): number {
  const ix = Math.floor((x + HALF) / sim.cell);
  const iz = Math.floor((z + HALF) / sim.cell);
  if (ix < 0 || iz < 0 || ix >= sim.gridSize || iz >= sim.gridSize) return -1;
  return iz * sim.gridSize + ix;
}

function countBits(mask: number): number {
  let bits = 0;
  for (let value = mask; value !== 0; value >>= 1) bits += value & 1;
  return bits;
}

function isShifted(keys: ReadonlySet<string>): boolean {
  return keys.has("ShiftLeft") || keys.has("ShiftRight");
}

function isAlt(keys: ReadonlySet<string>): boolean {
  return keys.has("AltLeft") || keys.has("AltRight");
}
