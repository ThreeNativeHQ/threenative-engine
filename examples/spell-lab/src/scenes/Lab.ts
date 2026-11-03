import {
  GPUParticles3D,
  type ICtx,
  Scene,
  type SceneFrame,
  WorldEnvironment,
} from "@threenative/core";
import {
  CastPool,
  type ICast,
  type ISpell,
  SpellWorld,
  createAegis,
  createArcaneBarrage,
  createFireball,
  createGlacialSpike,
  createInferno,
  createThunderstrike,
} from "@threenative/core/spells";
import {
  bakeNoise,
  createFx,
  fire as ultraFire,
  U as ultraU,
} from "@threenative/core/spells/ultra";
import {
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  LinearFilter,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from "three";
import { mix, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** What the HUD shows and what a playtest reads back. */
export interface LabState extends Record<string, unknown> {
  readonly spell: string;
  readonly casts: number;
}

/** The floor patch the spells paint, and the plane that shows it. They must cover the same square. */
const PATCH = 120;
const CELLS = 256;

/**
 * The six the first wave ships, as [input action, spell name] in number-key order. The two differ
 * because an input action is camelCase and a spell is a kebab-case capability name.
 */
const SPELL_KEYS: readonly (readonly [action: string, spell: string])[] = [
  ["fireball", "fireball"],
  ["thunderstrike", "thunderstrike"],
  ["glacialSpike", "glacial-spike"],
  ["arcaneBarrage", "arcane-barrage"],
  ["aegis", "aegis"],
  ["inferno", "inferno"],
];

type LabEvent = { readonly [key: string]: string | number };
const events: LabEvent[] = [];

/** Registered as an entity so a scenario can assert on what the lab actually did. */
class LabObservations {
  spell = "";
  casts = 0;
  impacts = 0;
  /** The `ReactionField` version, which only moves when a spell changes the floor. */
  floorMarks = 0;
  /** Particles the engine reports as spawned, summed over every emitter the lab owns. */
  spawned = 0;
  /** Emitters the world parented, and the first one's ring capacity. */
  emitters = 0;
  /** The newest cast's phase, so a scenario can see the timeline move. */
  phase = "none";
}

export class Lab extends Scene<LabState> {
  static override readonly initialState: LabState = { casts: 0, spell: "" };

  static drainEvents(): LabEvent[] {
    return events.splice(0, events.length);
  }

  override enter(ctx: ICtx<LabState>): SceneFrame<LabState> {
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 7.4, 13.5);
    camera.lookAt(0, 1.1, -2.5);
    // ?cam=x,y,z,tx,ty,tz: a close look for captures (upstream's ?campos)
    const cam = new URLSearchParams(globalThis.location?.search ?? "")
      .get("cam")
      ?.split(",")
      .map(Number);
    if (cam?.length === 6) {
      camera.position.set(cam[0] as number, cam[1] as number, cam[2] as number);
      camera.lookAt(cam[3] as number, cam[4] as number, cam[5] as number);
    }
    ctx.scene.background = new Color(0x1a2230);
    // Lit floor and dummies, so a spell's light shows on them: a dusk sky and a low sun.
    ctx.add(new HemisphereLight(0x6f86a8, 0x2a2622, 0.6));
    const sun = new DirectionalLight(0xffd2a8, 0.8);
    sun.position.set(-6, 5, 8);
    ctx.add(sun);
    // The stock look (filmic tone curve, metered exposure): the fire is HDR.
    new WorldEnvironment().apply(ctx.renderer, ctx.scene, ctx.camera);

    const observations = new LabObservations();
    ctx.entities.add("spell-lab", observations);

    const world = new SpellWorld({
      add: (object) => void ctx.add(object),
      camera,
      castSlots: 8,
      groundAt: () => 0,
      reaction: { resolution: CELLS, size: PATCH },
      scene: ctx.scene,
    });
    // Where a cast with no `from` starts: in front of the camera, at shoulder height.
    world.focus.set(0, 1.4, 4.5);

    const casts = new CastPool(world);
    // Key 1: the Ultra Elements Fireball, ported verbatim (@threenative/core/spells/ultra). The noise
    // is baked once before the spell builds its materials; 64^3 is upstream's low-tier size, the
    // 128^3 high tier costs ~5 s of CPU on this path (see noise.ts).
    bakeNoise({ noiseSize: 64 });
    const ultra = createFx({
      camera,
      size: () => ({
        width: Math.round((globalThis.innerWidth ?? 1280) * (globalThis.devicePixelRatio ?? 1)),
        height: Math.round((globalThis.innerHeight ?? 720) * (globalThis.devicePixelRatio ?? 1)),
      }),
      seed: 777,
    });
    ultraU.uSunDir.value.copy(sun.position).normalize();
    ultraU.uSunColor.value.set(1, 0.82, 0.66).multiplyScalar(0.8);
    ultraU.uAmbient.value.set(0.12, 0.14, 0.18);
    ctx.add(ultra.fx.scenes.fx);
    const fireball = ultra.addSpell(ultraFire);
    const spells: Record<string, ISpell> = {
      aegis: createAegis(world),
      "arcane-barrage": createArcaneBarrage(world),
      fireball: createFireball(world),
      "glacial-spike": createGlacialSpike(world),
      inferno: createInferno(world),
      thunderstrike: createThunderstrike(world),
    };

    const { refresh: refreshFloor, tint: floorTint } = createFloor(ctx, world, observations);
    const emitters = collectEmitters(world);
    createDummies(ctx);

    const target = new Vector3(0, 0.9, -4.5);
    const cast = (name: string): void => {
      if (name === "fireball")
        ultra.casts.cast(fireball, target, { form: "Fireball", from: world.focus });
      else {
        const spell = spells[name];
        if (spell === undefined) throw new Error(`spell-lab has no spell named ${name}`);
        casts.cast(spell, target, { from: world.focus });
      }
      observations.spell = name;
      observations.casts += 1;
      floorTint.value.copy(tintOf(name));
      events.push({ spell: name, type: "cast" });
    };

    /** Casts that have reached their impact or linger this frame. */
    const landed = (record: { phase: string }): boolean =>
      record.phase === "impact" || record.phase === "linger";

    const countLanded = (): number => {
      let n = 0;
      for (const record of casts.casts) if (landed(record)) n += 1;
      for (const record of ultra.casts.list) if (record.alive && landed(record)) n += 1;
      return n;
    };
    let previouslyLanded = 0;

    return (_frameCtx: ICtx<LabState>, dt: number) => {
      casts.update(dt);
      world.update(dt);
      ultra.renderFrame(dt);
      observations.phase = ultra.casts.active()?.phase ?? casts.active?.phase ?? "none";
      for (const [action, spell] of SPELL_KEYS) if (ctx.input.justPressed(action)) cast(spell);
      const current = countLanded();
      if (current > previouslyLanded) {
        observations.impacts += current - previouslyLanded;
        events.push({ impacts: observations.impacts, type: "impact" });
      }
      previouslyLanded = current;
      refreshFloor();
      let spawned = 0;
      for (const emitter of emitters) if (emitter !== undefined) spawned += emitter.stats.spawned;
      observations.spawned = spawned;
      observations.emitters = emitters.length;
    };
  }
}

/**
 * The floor, showing what the spells did to it.
 *
 * The game owns this: `ReactionField` reports heat, char, frost and wet, and the lab decides what
 * those look like. A different game paints the same numbers completely differently.
 */
function createFloor(
  ctx: ICtx<LabState>,
  world: SpellWorld,
  observations: LabObservations,
): { refresh: () => void; tint: { value: Color } } {
  const field = world.reaction;
  const data = new Uint8Array(CELLS * CELLS * 4);
  const map = new DataTexture(data, CELLS, CELLS, RGBAFormat, UnsignedByteType);
  map.minFilter = LinearFilter;
  map.magFilter = LinearFilter;
  map.needsUpdate = true;
  const material = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.85 });
  // The plane's v runs from the patch's +z edge upward, and a DataTexture's row 0 is its first
  // row, so exactly one of the two ends has to be flipped. It happens here, once, not per cell.
  const sample = texture(map, vec2(uv().x, uv().y.oneMinus()));
  const base = new Color(0x59647a);
  const burn = new Color(0x2a1408);
  /** The newest cast's own colour, so lightning does not scorch in fireball orange. */
  const glow = uniform(new Color(0xff6a1e));
  const cold = new Color(0x9fd8ff);
  material.colorNode = vec4(
    mix(mix(mix(base, burn, sample.g.mul(1.6)), glow, sample.r.mul(0.9)), cold, sample.b.mul(0.8)),
    1,
  );
  const floor = new Mesh(new PlaneGeometry(PATCH, PATCH), material);
  floor.rotation.x = -Math.PI / 2;
  floor.name = "spell-floor";
  ctx.add(floor);

  let version = -1;
  const refresh = (): void => {
    if (field === undefined || field.version === version) return;
    version = field.version;
    const heat = field.data("heat");
    const char = field.data("char");
    const wet = field.data("wet");
    const frost = field.data("frost");
    for (let index = 0; index < CELLS * CELLS; index++) {
      const out = index * 4;
      data[out] = Math.round((char[index] as number) * 255);
      data[out + 1] = Math.round((heat[index] as number) * 255);
      data[out + 2] = Math.round((frost[index] as number) * 255);
      data[out + 3] = Math.round((wet[index] as number) * 255);
    }
    map.needsUpdate = true;
    observations.floorMarks = field.version;
    events.push({ marks: field.version, type: "floor" });
  };
  return { refresh, tint: glow as unknown as { value: Color } };
}

/** The floor colour a spell leaves behind. The spells own their tints; the lab only echoes one. */
function tintOf(name: string): Color {
  switch (name) {
    case "thunderstrike":
      return new Color(0x6f8cff);
    case "glacial-spike":
      return new Color(0x9fe4ff);
    case "arcane-barrage":
      return new Color(0xff6ae0);
    case "aegis":
      return new Color(0xd98cff);
    default:
      return new Color(0xff6a1e);
  }
}

/** Every `GPUParticles3D` a spell added, so the lab can report what the engine thinks it did. */
function collectEmitters(world: SpellWorld): (GPUParticles3D | undefined)[] {
  return world.objects.filter((child): child is GPUParticles3D => child instanceof GPUParticles3D);
}

/** Three dummies to aim at, matching the row the upstream spells were built against. */
function createDummies(ctx: ICtx<LabState>): void {
  const body = new CylinderGeometry(0.42, 0.5, 1.9, 16);
  const material = new MeshStandardNodeMaterial({ color: new Color(0xaab6c8), roughness: 0.7 });
  for (const [index, x] of [-4, 0, 4].entries()) {
    const dummy = new Mesh(body, material);
    dummy.position.set(x, 0.95, -4.5);
    dummy.name = `dummy-${index}`;
    ctx.add(dummy);
  }
}
