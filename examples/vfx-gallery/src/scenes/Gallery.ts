import { GPUParticles3D, GPUReadback, type ICtx, Scene, type SceneFrame } from "@threenative/core";
import {
  BoxGeometry,
  Color,
  GridHelper,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  createBurstFlash,
  createEffekseerHit01,
  createEffekseerHit02,
  createEmberFountain,
  createImpactSparks,
  createMuzzleFlash,
  createSparkStreaks,
} from "../render/combat.js";
import {
  createGodotBloodSplash,
  createGodotFireflies,
  createGodotShieldBreak,
  createGodotWaterfallMist,
  createKenneyConfettiBurst,
  createKenneyLeafSwirl,
  createKenneySlashArc,
  createPixiBubbleStream,
  createPixiCartoonSmokeBlast,
} from "../render/extras.js";
import {
  createAshPlume,
  createDustCloud,
  createEffekseerWind01,
  createEffekseerWind02,
  createEffekseerWind03,
  createExplosionCloud,
  createFire,
  createGroundMist,
  createImpactDust,
  createJetFlame,
  createPoisonCloud,
  createRain,
  createSmoke,
  createSnow,
  createSteamPlume,
} from "../render/fireSmokeWeather.js";
import {
  createEffekseerFire01,
  createEffekseerFire02,
  createEffekseerFire03,
  createEffekseerHoly01,
  createEffekseerIce01,
  createEffekseerIce02,
  createEffekseerIce03,
  createEffekseerLightning01,
  createEffekseerLightning02,
  createEffekseerLightning03,
  createHealingAura,
  createMagicBeam,
  createMagicOrb,
  createMagicWisp,
} from "../render/magic.js";
import { type IPortalVortex, createPortalVortex } from "../render/portalVortex.js";

const EFFECT_IDS = [
  "fire",
  "jet-flame",
  "burst-flash",
  "muzzle-flash",
  "smoke",
  "dust-cloud",
  "steam-plume",
  "ash-plume",
  "explosion-cloud",
  "impact-dust",
  "ground-mist",
  "poison-cloud",
  "rain",
  "snow",
  "spark-streaks",
  "impact-sparks",
  "ember-fountain",
  "magic-wisp",
  "magic-orb",
  "magic-beam",
  "healing-aura",
  "effekseer-fire01",
  "effekseer-fire02",
  "effekseer-fire03",
  "effekseer-lightning01",
  "effekseer-lightning02",
  "effekseer-lightning03",
  "effekseer-ice01",
  "effekseer-ice02",
  "effekseer-ice03",
  "effekseer-holy01",
  "effekseer-hit01",
  "effekseer-hit02",
  "effekseer-wind01",
  "effekseer-wind02",
  "effekseer-wind03",
  "kenney-slash-arc",
  "kenney-confetti-burst",
  "kenney-leaf-swirl",
  "pixi-bubble-stream",
  "pixi-cartoon-smoke-blast",
  "godot-fireflies",
  "godot-portal-vortex",
  "godot-blood-splash",
  "godot-shield-break",
  "godot-waterfall-mist",
] as const;

export const EFFECT_LABELS = [
  { name: "Fire", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Jet Flame", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Burst Flash", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Muzzle Flash", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Smoke", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Dust Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Steam Plume", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ash Plume", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Explosion Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Impact Dust", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ground Mist", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Poison Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Rain", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Snow", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Spark Streaks", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Impact Sparks", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ember Fountain", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Wisp", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Orb", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Beam", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Healing Aura", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Effekseer Fire 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Fire 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Fire 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Holy 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Hit 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Hit 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Kenney Slash Arc", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Kenney Confetti Burst", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Kenney Leaf Swirl", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Pixi Bubble Stream", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Pixi Cartoon Smoke Blast", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Fireflies", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Portal Vortex", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Blood Splash", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Shield Break", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Waterfall Mist", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
] as const;

const PAGE_SIZE = 9;
const PAGE_COUNT = Math.ceil(EFFECT_IDS.length / PAGE_SIZE);
const COLUMN_COUNT = 3;
const COLUMN_WIDTH = 4;
const ROW_DEPTH = 3.2;

export type GalleryState = {
  readonly appliedIds: readonly string[];
  readonly evaluatedTiles: number;
  readonly missingTiles: readonly string[];
  readonly page: number;
  readonly pagesVisited: number;
  readonly burstCommands: number;
  readonly gpuCapacity: number;
  readonly portalRingDispatches: number;
  readonly portalRibbonDispatches: number;
};

type GalleryCtx = ICtx<GalleryState>;

const initialState: GalleryState = {
  appliedIds: [],
  evaluatedTiles: 0,
  missingTiles: [...EFFECT_IDS],
  page: 0,
  pagesVisited: 1,
  burstCommands: 0,
  gpuCapacity: 0,
  portalRingDispatches: 0,
  portalRibbonDispatches: 0,
};

type GalleryEvent = { readonly [key: string]: string | number };
const events: GalleryEvent[] = [];

export function drainGalleryEvents(): GalleryEvent[] {
  return events.splice(0, events.length);
}

class GalleryEffectEntity {
  readonly effectId: string;
  readonly page: number;
  #objects: readonly Object3D[] = [];
  #spawnCommands = 0;
  #gpuCapacity = 0;
  #activated = false;
  readonly #placeholder = new Object3D();

  constructor(effectId: string, page: number) {
    this.effectId = effectId;
    this.page = page;
  }

  get mesh(): Object3D {
    return this.#objects[0] ?? this.#placeholder;
  }

  get objects(): readonly Object3D[] {
    return this.#objects;
  }

  get spawnCommands(): number {
    return this.#spawnCommands;
  }

  get gpuCapacity(): number {
    return this.#gpuCapacity;
  }

  setObjects(objects: readonly Object3D[], gpuCapacity: number, spawnCommands: number): void {
    this.deactivate();
    this.#objects = objects;
    this.#gpuCapacity = gpuCapacity;
    this.#spawnCommands = spawnCommands;
    this.#activated = true;
    for (const object of objects) object.visible = true;
    for (const object of objects) {
      if (object instanceof GPUParticles3D) object.emitting = true;
    }
  }

  deactivate(): void {
    for (const object of this.#objects) object.removeFromParent();
    this.#objects = [];
  }

  setVisible(page: number): void {
    const visible = page === this.page;
    for (const object of this.objects) {
      object.visible = visible;
      if (object instanceof GPUParticles3D) object.emitting = visible;
    }
  }

  debug(): Record<string, unknown> {
    return {
      effectId: this.effectId,
      gpuCapacity: this.gpuCapacity,
      spawnCommands: this.spawnCommands,
      evaluated: this.#activated,
    };
  }
}

/** Opt-in (`?burstProbe`): drives the restart-based burst of the action-rpg template and reads it back. */
function createBurstProbe(ctx: GalleryCtx): () => void {
  if (typeof location === "undefined" || !new URLSearchParams(location.search).has("burstProbe"))
    return () => undefined;
  const option = createImpactSparks(83)[0];
  if (option === undefined) throw new Error("Burst probe requires an impact-sparks layer.");
  const particles = ctx.add(new GPUParticles3D(option));
  particles.name = "burst-probe-sparks";
  particles.visible = false;
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
      particles.visible = false;
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

type GalleryParticleOptions = ConstructorParameters<typeof GPUParticles3D>[0];
type GalleryEffectFactory = (seed: number) => readonly GalleryParticleOptions[];
type GalleryEffectDefinition = {
  readonly id: string;
  readonly index: number;
  readonly factory: GalleryEffectFactory;
  readonly seed: number;
};

const EFFECT_DEFINITIONS: readonly GalleryEffectDefinition[] = [
  { id: "fire", index: 0, factory: createFire, seed: 11 },
  { id: "jet-flame", index: 1, factory: createJetFlame, seed: 13 },
  { id: "burst-flash", index: 2, factory: createBurstFlash, seed: 71 },
  { id: "muzzle-flash", index: 3, factory: createMuzzleFlash, seed: 73 },
  { id: "smoke", index: 4, factory: createSmoke, seed: 17 },
  { id: "dust-cloud", index: 5, factory: createDustCloud, seed: 19 },
  { id: "steam-plume", index: 6, factory: createSteamPlume, seed: 23 },
  { id: "ash-plume", index: 7, factory: createAshPlume, seed: 29 },
  { id: "explosion-cloud", index: 8, factory: createExplosionCloud, seed: 31 },
  { id: "impact-dust", index: 9, factory: createImpactDust, seed: 37 },
  { id: "ground-mist", index: 10, factory: createGroundMist, seed: 41 },
  { id: "poison-cloud", index: 11, factory: createPoisonCloud, seed: 43 },
  { id: "rain", index: 12, factory: createRain, seed: 47 },
  { id: "snow", index: 13, factory: createSnow, seed: 53 },
  { id: "spark-streaks", index: 14, factory: createSparkStreaks, seed: 79 },
  { id: "impact-sparks", index: 15, factory: createImpactSparks, seed: 83 },
  { id: "ember-fountain", index: 16, factory: createEmberFountain, seed: 89 },
  { id: "magic-wisp", index: 17, factory: createMagicWisp, seed: 103 },
  { id: "magic-orb", index: 18, factory: createMagicOrb, seed: 107 },
  { id: "magic-beam", index: 19, factory: createMagicBeam, seed: 109 },
  { id: "healing-aura", index: 20, factory: createHealingAura, seed: 113 },
  { id: "effekseer-fire01", index: 21, factory: createEffekseerFire01, seed: 127 },
  { id: "effekseer-fire02", index: 22, factory: createEffekseerFire02, seed: 131 },
  { id: "effekseer-fire03", index: 23, factory: createEffekseerFire03, seed: 137 },
  { id: "effekseer-lightning01", index: 24, factory: createEffekseerLightning01, seed: 139 },
  { id: "effekseer-lightning02", index: 25, factory: createEffekseerLightning02, seed: 149 },
  { id: "effekseer-lightning03", index: 26, factory: createEffekseerLightning03, seed: 151 },
  { id: "effekseer-ice01", index: 27, factory: createEffekseerIce01, seed: 157 },
  { id: "effekseer-ice02", index: 28, factory: createEffekseerIce02, seed: 163 },
  { id: "effekseer-ice03", index: 29, factory: createEffekseerIce03, seed: 167 },
  { id: "effekseer-holy01", index: 30, factory: createEffekseerHoly01, seed: 173 },
  { id: "effekseer-hit01", index: 31, factory: createEffekseerHit01, seed: 97 },
  { id: "effekseer-hit02", index: 32, factory: createEffekseerHit02, seed: 101 },
  { id: "effekseer-wind01", index: 33, factory: createEffekseerWind01, seed: 59 },
  { id: "effekseer-wind02", index: 34, factory: createEffekseerWind02, seed: 61 },
  { id: "effekseer-wind03", index: 35, factory: createEffekseerWind03, seed: 67 },
  { id: "kenney-slash-arc", index: 36, factory: createKenneySlashArc, seed: 179 },
  { id: "kenney-confetti-burst", index: 37, factory: createKenneyConfettiBurst, seed: 181 },
  { id: "kenney-leaf-swirl", index: 38, factory: createKenneyLeafSwirl, seed: 191 },
  { id: "pixi-bubble-stream", index: 39, factory: createPixiBubbleStream, seed: 193 },
  { id: "pixi-cartoon-smoke-blast", index: 40, factory: createPixiCartoonSmokeBlast, seed: 197 },
  { id: "godot-fireflies", index: 41, factory: createGodotFireflies, seed: 199 },
  { id: "godot-blood-splash", index: 43, factory: createGodotBloodSplash, seed: 211 },
  { id: "godot-shield-break", index: 44, factory: createGodotShieldBreak, seed: 223 },
  { id: "godot-waterfall-mist", index: 45, factory: createGodotWaterfallMist, seed: 227 },
];

function tilePosition(index: number): Vector3 {
  const slot = index % PAGE_SIZE;
  const column = slot % COLUMN_COUNT;
  const row = Math.floor(slot / COLUMN_COUNT);
  return new Vector3((column - (COLUMN_COUNT - 1) / 2) * COLUMN_WIDTH, 0.18, (row - 1) * ROW_DEPTH);
}

function createGalleryStage(ctx: GalleryCtx): void {
  const floor = ctx.add(
    new Mesh(
      new PlaneGeometry(22, 18),
      new MeshBasicMaterial({ color: 0x050a16, depthWrite: true }),
    ),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;

  const grid = ctx.add(new GridHelper(22, 22, 0x111a28, 0x091222));
  grid.position.y = 0.005;

  for (let slot = 0; slot < PAGE_SIZE; slot += 1) {
    const plate = ctx.add(
      new Mesh(
        new BoxGeometry(2.6, 0.11, 2.1),
        new MeshBasicMaterial({ color: 0x071020, transparent: true, opacity: 0.88 }),
      ),
    );
    plate.position.copy(tilePosition(slot));
    plate.position.y = 0.055;
  }
}

export class Gallery extends Scene<GalleryState> {
  static override readonly initialState = initialState;

  override enter(ctx: GalleryCtx): SceneFrame<GalleryState> {
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 8.35, 11.8);
    camera.lookAt(0, 0.65, 0);
    ctx.viewport.resize();
    ctx.add(camera);
    ctx.scene.background = new Color(0x050a16);
    createGalleryStage(ctx);
    const updateBurstProbe = createBurstProbe(ctx);

    const effectEntities = new Map<string, GalleryEffectEntity>();
    for (const [index, id] of EFFECT_IDS.entries()) {
      const entity = new GalleryEffectEntity(id, Math.floor(index / PAGE_SIZE));
      effectEntities.set(id, entity);
      ctx.entities.add(id, entity);
    }

    let portal: IPortalVortex | undefined;
    const entityFor = (id: string): GalleryEffectEntity => {
      const entity = effectEntities.get(id);
      if (entity === undefined) throw new Error(`VFX gallery effect was not registered: ${id}`);
      return entity;
    };

    const mountParticles = (definition: GalleryEffectDefinition): void => {
      const position = tilePosition(definition.index);
      const particles = definition.factory(definition.seed).map((option, layerIndex) => {
        const particle = ctx.add(new GPUParticles3D(option));
        particle.name = `vfx-${definition.id}-${layerIndex}`;
        particle.position.copy(position);
        return particle;
      });
      entityFor(definition.id).setObjects(
        particles,
        particles.reduce((total, particle) => total + particle.amount, 0),
        particles.length,
      );
    };

    const mountPortal = (): void => {
      const nextPortal = createPortalVortex(229);
      const portalRing = ctx.add(new GPUParticles3D(nextPortal.ring));
      portalRing.name = "vfx-godot-portal-vortex-ring";
      portalRing.position.copy(tilePosition(42));
      const portalRibbons = ctx.add(nextPortal.ribbons);
      portalRibbons.name = "vfx-godot-portal-vortex-ribbons";
      portalRibbons.position.copy(tilePosition(42));
      entityFor("godot-portal-vortex").setObjects(
        [portalRing, portalRibbons],
        nextPortal.gpuCapacity,
        nextPortal.spawnCommands,
      );
      portal = nextPortal;
    };

    const visitedPages = new Set<number>([0]);
    const mountPage = (page: number): void => {
      for (const entity of effectEntities.values()) entity.deactivate();
      for (const definition of EFFECT_DEFINITIONS) {
        if (Math.floor(definition.index / PAGE_SIZE) === page) mountParticles(definition);
      }
      if (page === Math.floor(42 / PAGE_SIZE)) mountPortal();
      visitedPages.add(page);
    };

    mountPage(0);

    if (typeof window !== "undefined") {
      window.addEventListener("threenative-gallery-retrigger", () => {
        const page = ctx.state.getState().page;
        for (const entity of effectEntities.values()) {
          if (entity.page !== page) continue;
          for (const object of entity.objects) {
            if (object instanceof GPUParticles3D) object.restart();
          }
        }
      });
    }

    return (frameCtx) => {
      updateBurstProbe();
      if (frameCtx.input.justPressed("nextPage")) {
        const page = (frameCtx.state.getState().page + 1) % PAGE_COUNT;
        mountPage(page);
        const portalDispatches = portal?.ribbons.dispatches ?? 0;
        const complete = visitedPages.size === PAGE_COUNT;
        frameCtx.state.set({
          appliedIds: complete ? [...EFFECT_IDS] : [],
          evaluatedTiles: complete ? EFFECT_IDS.length : 0,
          missingTiles: complete ? [] : [...EFFECT_IDS],
          page,
          pagesVisited: frameCtx.state.getState().pagesVisited + 1,
          burstCommands: complete ? EFFECT_IDS.length : 0,
          gpuCapacity: EFFECT_IDS.reduce((total, id) => total + entityFor(id).gpuCapacity, 0),
          portalRingDispatches: portalDispatches > 0 ? 1 : 0,
          portalRibbonDispatches: portalDispatches,
        });
        events.push({ entity: "gallery", name: "coverage", count: EFFECT_IDS.length });
        events.push({ entity: "gallery", name: "page", page });
        if (portalDispatches > 0) {
          events.push({
            entity: "godot-portal-vortex",
            name: "compute-updated",
            dispatches: portalDispatches,
          });
        }
      }
    };
  }
}
