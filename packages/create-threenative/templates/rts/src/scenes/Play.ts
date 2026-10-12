import { type ICtx, Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { Object3D, type OrthographicCamera, type Texture, type Vector2 } from "three";
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
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { type ISun, setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { createUnitModels } from "../render/models.js";
import { type PickTarget, pickEntity, unitsInBox } from "../render/picking.js";
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
/** A drag shorter than this is a click, not a box. */
const DRAG_SLOP = 4;
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
  #found: number[] = [];
  #kinds = new Uint8Array(ORDER_KINDS.length);
  #mode = "";
  #pointerSeen = false;
  #accumulator = 0;
  #minimapDirty = true;
  #publishedStep = -1;
  #notice = "";
  #fogText = "";
  #dots: number[] = [];
  #patch: Partial<GameState> = {};

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
    world.add(this.#terrain.root, this.#resources.root, this.#army.root, this.#anchor.object);
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

    return (frameCtx, dt) => {
      loading.update();
      this.#readInput(frameCtx, dt);
      this.#accumulator = Math.min(this.#accumulator + dt, MAX_CATCH_UP);
      while (this.#accumulator >= STEP) {
        sim.update(STEP);
        this.#accumulator -= STEP;
      }
      this.#drain(sim);
      this.#prune(sim);
      applyRtsCamera(camera, view, frameCtx.viewport.size, dt);
      sun.follow(view.target.x, view.target.z);
      this.#army?.sync(sim, this.#selected, sim.time, dt, camera);
      if (this.#minimapDirty) {
        this.#minimapDirty = false;
        this.#terrain?.updateFog(sim);
        this.#resources?.sync(sim);
        this.#minimap(sim);
      }
      this.#publish(frameCtx, sim, view);
    };
  }

  override exit(ctx: GameCtx): void {
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
    const camera = ctx.camera as OrthographicCamera;
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
    const zoom = ctx.input.axis("zoom");
    if (zoom !== 0) zoomRts(view, zoom);

    if (this.#drag !== undefined) {
      const live = raw.pointers.get(this.#drag.id);
      if (live !== undefined) this.#drag.to.copy(live.position);
    }
    for (const edges of raw.pointerEdges.values())
      for (const edge of edges) {
        if (edge.type !== "down") {
          this.#release(ctx, edge.id, edge.position);
        } else if ((edge.buttons & 2) !== 0) {
          this.#orderAt(ctx, edge.position, isShifted(keys));
        } else {
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

  #release(ctx: GameCtx, id: number, at: Vector2): void {
    const drag = this.#drag;
    const sim = this.#sim;
    const view = this.#view;
    if (drag === undefined || drag.id !== id || sim === undefined || view === undefined) return;
    this.#drag = undefined;
    const camera = ctx.camera as OrthographicCamera;
    const size = ctx.viewport.size;
    const keys = ctx.input.raw.keys;
    if (Math.hypot(at.x - drag.from.x, at.y - drag.from.y) <= DRAG_SLOP) {
      const hit = pickEntity(sim, camera, view, size, at.x, at.y);
      if (hit === undefined) {
        if (!isShifted(keys)) this.#selectIds([]);
        return;
      }
      this.#toggleSelection(hit, isShifted(keys));
      return;
    }
    // Shift adds to what is selected; a fresh drag replaces it.
    const keep = isShifted(keys) ? this.#selection.filter((id) => sim.get(id)?.team === 0) : [];
    unitsInBox(sim, camera, view, size, drag.from, drag.to, isAlt(keys), this.#found);
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
    for (const id of this.#selection) {
      const entity = sim.get(id);
      if (entity === undefined || entity.garrisonId !== null) continue;
      count += 1;
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
    patch.primaryHp = primary?.hp ?? 0;
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
    if (this.#drag === undefined) {
      patch.dragBox = null;
    } else {
      // Mutated in place: the store holds the reference and the bridge clones at the boundary, so
      // a rubber band does not allocate a fresh array on every frame it is being dragged.
      this.#box[0] = Math.min(this.#drag.from.x, this.#drag.to.x);
      this.#box[1] = Math.min(this.#drag.from.y, this.#drag.to.y);
      this.#box[2] = Math.abs(this.#drag.to.x - this.#drag.from.x);
      this.#box[3] = Math.abs(this.#drag.to.y - this.#drag.from.y);
      patch.dragBox = this.#box;
    }
    if (this.#publishedStep !== Math.floor(sim.time * 20)) {
      this.#publishedStep = Math.floor(sim.time * 20);
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
    ctx.state.set(patch);
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
