// Ported from Ultra Elements src/main.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// Only the part of main.js every spell depends on: the shared `fx` world (main.js ~line 94) and the
// CPU half of renderFrame (clock, casts, packWorld, systems). Upstream's renderer, arena, sky,
// PostFX, GUI and capture are not ported: the game's scene, its lights and WorldEnvironment replace
// them. The services later slices port (particles, trails, ground, shocks, fluid, rig, arena focus)
// are typed seams below; until a slice lands, each is an inert stand-in that keeps the spell code verbatim.
import {
  type Camera,
  type Color,
  type Object3D,
  PointLight,
  type Scene,
  type Vector3,
} from "three";
import { Q } from "./engine/quality.js";
import { Casts, type ICast, type ISpell } from "./spells/cast.js";
import { FluidVolume } from "./vfx/FluidVolume.js";
import { FxTarget } from "./vfx/FxTarget.js";
import { type IParticleGround, Particles } from "./vfx/Particles.js";
import { Volumes } from "./vfx/Volumes.js";
import {
  ARENA,
  U,
  forces,
  impacts,
  lights,
  mirrorLights,
  occluders,
  packWorld,
} from "./vfx/common.js";

// --- service seams (Ribbons.js, GroundField.js, Shockwaves.js, FluidVolume.js, camera.js, arena.js) ---
export interface ITrail {
  width: number;
  intensity: number;
  glow: number;
  glowIntensity: number;
  fadeTime: number;
  distortion: number;
  color: Color;
  push(p: Vector3): void;
  release(): void;
}
export interface ITrails {
  acquire(): ITrail | null;
}
export interface IShocks {
  spawn(shock: object): void;
}
export interface IGround {
  splat(splat: object): void;
}
export interface IFluidDomain {
  position: Vector3;
  size: Vector3;
  h: number;
  heat: number;
  tint: Color;
  sootColor: Color;
  detailCenter: Vector3;
  obstacle: { set(x: number, y: number, z: number, r: number): void };
  emit(source: object): void;
  release(): void;
  [field: string]: unknown;
}
export interface IFluid {
  res: number;
  acquire(options: { size: number[]; res?: number }): IFluidDomain | null;
}
export interface IRig {
  shake(amount: number, frequency: number): void;
  punch(amount: number, seconds: number): void;
  hitstop(seconds: number): void;
}
export interface IArena {
  focus: { color: Color };
  setFocus(color: Color, intensity: number): void;
}
export interface IDummy {
  pos: Vector3;
  status: { burn: number };
  hit(dir: Vector3, amount: number): void;
}

const NULL_TRAILS: ITrails = { acquire: () => null };
const NULL_GROUND: IGround = { splat() {} };
const NULL_FLUID: IFluid = { res: 0, acquire: () => null };
const NULL_RIG: IRig = { shake() {}, punch() {}, hitstop() {} };

export interface IFxOptions {
  camera: Camera;
  /** compiles each spell's pipelines before its first cast (warmSpell); upstream: renderer.compileAsync */
  renderer?: {
    compileAsync(object: Object3D, camera: Camera, scene?: Scene): Promise<unknown>;
    compute(node: unknown): unknown; // runs the particle sim kernel (Particles.ts)
  };
  /** drawing-buffer size in pixels (upstream: renderer.getDrawingBufferSize) */
  size: () => { width: number; height: number };
  seed?: number;
  /** PointLights the spell lights drive (common.ts mirrorLights); parked at 0 when idle */
  pointLights?: number;
  trails?: ITrails;
  ground?: IGround;
  shocks?: IShocks;
  fluid?: IFluid;
  rig?: IRig;
  arena?: IArena;
  dummies?: IDummy[];
}

// the shared world every spell gets (PLAN 2.4). Spells only touch what's in here.
export function createFx(o: IFxOptions) {
  let seed = o.seed ?? 1;
  const fxTarget = new FxTarget();
  const volumes = new Volumes();
  const flashes: number[] = [];
  const fx = {
    camera: o.camera,
    scenes: { fx: fxTarget.scene },
    U,
    Q,
    ARENA,
    arena: o.arena ?? { focus: { color: { r: 1, g: 1, b: 1 } as Color }, setFocus() {} },
    ground: o.ground ?? NULL_GROUND,
    particles: null as unknown as Particles,
    trails: o.trails ?? NULL_TRAILS,
    volumes,
    shocks: o.shocks as IShocks | undefined,
    // the shared combustion fluid (upstream FluidVolume.get(fx)): built on first use, inside the spell's
    // create(), so its box meshes count as that spell's objects and warmSpell compiles them
    get fluid(): IFluid {
      return o.fluid ?? (fx.renderer ? FluidVolume.get(fx) : NULL_FLUID);
    },
    fluidVolume: undefined as FluidVolume | undefined,
    // the raw renderer the GPU systems draw their passes with (ctx.renderer.raw on ThreeNative)
    renderer: ((o.renderer as { raw?: unknown } | undefined)?.raw ?? o.renderer) as
      | ConstructorParameters<typeof FluidVolume>[0]["renderer"]
      | undefined,
    rig: o.rig ?? NULL_RIG,
    lights,
    forces,
    impacts,
    occluders,
    fxTarget,
    dummies: o.dummies ?? [],
    spells: {} as Record<string, ISpell>,
    reduced: false,
    systems: [] as { update(dt: number, camera: Camera): void }[], // extra GPU systems: { update(dt, camera) }, run in the timed sim section every frame
    flashAmount: 0, // upstream: post.params.flash; the game's post reads it
    rand() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    },
    // reduced-motion aware flash (WCAG 2.3.1: at most 3 flashes per second)
    flash(amount: number) {
      const now = globalThis.performance?.now() ?? Date.now();
      while (flashes.length > 0 && now - (flashes[0] as number) >= 1000) flashes.shift();
      // biome-ignore lint/style/noParameterAssign: upstream Ultra Elements code, copied verbatim
      if (fx.reduced && (flashes.length >= 3 || amount > 0.3)) amount = Math.min(amount, 0.15);
      flashes.push(now);
      fx.flashAmount = Math.min(2, Math.max(fx.flashAmount, amount));
    },
    casts: null as unknown as Casts,
  };
  fxTarget.scene.add(volumes.group);
  const points = Array.from({ length: o.pointLights ?? 4 }, (_, i) => {
    const l = new PointLight(0xffffff, 0, 8, 2);
    l.name = `ultra-spell-light-${i}`;
    fxTarget.scene.add(l);
    return l;
  });
  const casts = new Casts(fx);
  fx.casts = casts;
  const particles = new Particles(o.renderer ?? null, { ground: fx.ground as IParticleGround });
  fx.particles = particles;
  // TEMP lane gate (team-lead, removed at integration): build only with ?lane=particles or ?lane=all
  const lanes = new URLSearchParams(globalThis.location?.search ?? "").getAll("lane");
  const particlesLane = lanes.includes("particles") || lanes.includes("all");
  function buildParticles(): void {
    if (particles.built || !particlesLane) return;
    particles.build();
    fxTarget.scene.add(particles.glow, particles.media, ...particles.debris);
  }

  let simTime = 0;
  let w = 0;
  let h = 0;
  // the CPU half of upstream's renderFrame(dt)
  function renderFrame(dt: number): void {
    const s = o.size();
    if (s.width !== w || s.height !== h) {
      w = s.width;
      h = s.height;
      fxTarget.setSize(w, h, Q.fxScale);
    }
    simTime += dt;
    U.uTime.value = simTime % 3600;
    U.uDt.value = dt;
    U.uFrame.value++;
    const cam = o.camera as Camera & { near?: number; far?: number };
    if (cam.near !== undefined && cam.far !== undefined) U.uNearFar.value.set(cam.near, cam.far);

    // CPU: casts emit, lights/forces/impacts pack into the world texture
    casts.update(dt);
    for (const sp of Object.values(fx.spells))
      (sp.inst as { tick?(dt: number): void } | undefined)?.tick?.(dt);
    packWorld(dt, { maxLights: Q.maxLights, maxShadowed: Q.shadowLights });
    mirrorLights(points);
    buildParticles();
    particles.update(dt, simTime);

    volumes.update(o.camera);
    for (const sys of fx.systems) sys.update(dt, o.camera);
    fxTarget.render();
    fx.flashAmount = Math.max(0, fx.flashAmount - dt * 6);
  }

  // spell modules: create() once each (upstream: the SPELLS loop in main.js). Remember the scene
  // objects it added: its programs are compiled and warmed on their own (warmSpell).
  const sceneObjects = () => {
    const set = new Set<Object3D>();
    fxTarget.scene.traverse((o) => set.add(o));
    return set;
  };
  const spellObjects = new Map<ISpell, Object3D[]>();
  const warming = new Map<ISpell, Promise<void>>();
  function addSpell<S extends ISpell & { create(fx: Fx): NonNullable<ISpell["inst"]> }>(s: S): S {
    (s as { defaults?: object }).defaults = { ...s.params };
    s.params = { ...s.params };
    for (const [k, def] of Object.entries((s as { kinds?: object }).kinds ?? {}))
      particles.addKind(`${s.id}.${k}`, def);
    const before = sceneObjects();
    s.inst = s.create(fx);
    spellObjects.set(
      s,
      [...sceneObjects()].filter((o) => !before.has(o)),
    );
    fx.spells[s.id] = s;
    return s;
  }
  // per-spell warm-up (upstream warmSpell): compile its pipelines with its objects forced on, so the
  // first cast does not compile mid-frame. Engine: the compile reads the scene when it is called, so
  // the objects are on for that call only and no presented frame draws them with unset uniforms.
  // Upstream's second step, one draw into a 4x4 target, has no engine route: the Wasm renderer's
  // setRenderTarget refuses any target (three-native browser-renderer.ts setRenderTarget).
  function warmSpell(s: ISpell): Promise<void> {
    let job = warming.get(s);
    if (job === undefined) {
      buildParticles();
      particles.warm(true);
      const objects = spellObjects.get(s) ?? [];
      const saved = objects.map((obj) => obj.visible);
      for (const obj of objects) obj.visible = true;
      let root: Object3D = fxTarget.scene;
      while (root.parent !== null) root = root.parent; // upstream sceneOf: the scene's lights pick the variant
      try {
        job = (
          o.renderer?.compileAsync(fxTarget.scene, o.camera, root as Scene) ?? Promise.resolve()
        ).then(() => undefined);
      } finally {
        objects.forEach((obj, i) => {
          obj.visible = saved[i] as boolean;
        });
        particles.warm(false);
      }
      warming.set(s, job);
    }
    return job;
  }

  return { fx, casts, renderFrame, addSpell, warmSpell, pointLights: points };
}
export type Fx = ReturnType<typeof createFx>["fx"];
export type { ICast };
