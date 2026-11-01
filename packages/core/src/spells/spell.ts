/**
 * One recipe, six spells.
 *
 * Every spell in the first wave is the same four beats with different numbers in them: something
 * charges, something crosses the room, something lands, and the room stays changed. So this is one
 * factory that builds a spell out of a recipe, and each `create<Spell>` is a recipe plus a look.
 * That is what keeps the cost honest — a game that imports one spell gets one factory, not a
 * catalog.
 *
 * Drawables (the ball, the shell, the bolt, the shield) and emitters are built once at `create` and
 * only shown, hidden and re-emitted at cast time, so the first cast of a spell costs exactly what
 * its hundredth does. Every drawable is per pool slot: two fireballs in the air at once do not fight
 * over one sprite.
 */

import { Color, Vector3 } from "three/webgpu";
import {
  type ParticleKindName,
  ParticleKindTable,
  type ParticleStyle,
  createParticleKindEmitter,
} from "../particle-kinds.js";
import { GPUParticles3D } from "../particles.js";
import type { CastShape, ICast, ICastTiming, ISpell } from "./cast-pool.js";
import { type ISpellDrawables, createDrawables } from "./mechanisms.js";
import type { ReactionPattern } from "./reaction-field.js";
import type { SpellWorld } from "./spell-world.js";

/** What a spell is at birth, and what it cools to. */
export interface ISpellTint {
  readonly colour: Color;
  readonly highlight: Color;
}

/** A particle role. `burst` is particles per emission. */
export interface ISpellEmitter {
  readonly kind: ParticleKindName;
  readonly burst: number;
  /** Seconds between repeated emissions. Ignored while travelling, which emits every frame. */
  readonly interval?: number;
  readonly style?: ParticleStyle;
}

export interface ISpellImpact {
  /**
   * `hold` keeps the shell at full strength for the whole linger instead of expanding once. A ward
   * around the caster holds; an impact wave expands.
   */
  readonly shell?: {
    readonly radius: number;
    readonly seconds: number;
    readonly strength: number;
    readonly hold?: boolean;
  };
  readonly light?: { readonly intensity: number; readonly range: number; readonly seconds: number };
  readonly splat?: {
    readonly radius: number;
    readonly pattern?: ReactionPattern;
    readonly heat?: number;
    readonly char?: number;
    readonly wet?: number;
    readonly frost?: number;
    readonly crack?: number;
    readonly glow?: number;
  };
  /** Camera shake amplitude in metres. */
  readonly shake?: number;
}

/** Everything a spell is. A factory is a recipe; the look is the tint. */
export interface ISpellRecipe {
  readonly name: string;
  readonly shape: CastShape;
  readonly speed?: number;
  readonly radius?: number;
  readonly timing: Required<ICastTiming>;
  readonly tint: ISpellTint;
  /** Metres across the ball, and how hard it burns. */
  readonly core?: { readonly radius: number; readonly intensity: number };
  /** Motes pulled in while the spell winds up. */
  readonly charge?: ISpellEmitter;
  /** What the ball sheds as it flies. */
  readonly trail?: ISpellEmitter;
  /** What the impact throws. */
  readonly burst?: ISpellEmitter;
  /** What keeps burning after the impact. */
  readonly linger?: ISpellEmitter;
  readonly impact: ISpellImpact;
  /** A column from the sky to the point. `height` is how far up it starts. */
  readonly bolt?: { readonly width: number; readonly height: number; readonly seconds: number };
}

/** Per-cast scratch, one object per pool slot, so a cast allocates nothing. */
interface ICastScratch {
  sinceImpact: number;
  emitTimer: number;
}

interface IBuilt {
  readonly drawables: ISpellDrawables[];
  readonly scratch: ICastScratch[];
  readonly charge: GPUParticles3D | undefined;
  readonly trail: GPUParticles3D | undefined;
  readonly burst: GPUParticles3D | undefined;
  readonly linger: GPUParticles3D | undefined;
}

/**
 * Build a spell from a recipe.
 *
 * The returned object is an `ISpell`: hand it to `CastPool.cast` and the pool drives it. It reads
 * the world only through `SpellWorld`, so a game can swap the scene, the floor or the light pool
 * without touching the spell.
 */
export function createSpell(world: SpellWorld, recipe: ISpellRecipe): ISpell {
  const built = build(world, recipe);
  const position = new Vector3();
  const sky = new Vector3();
  const lightColour = new Color();
  const shellColour = new Color();

  return {
    name: recipe.name,
    radius: recipe.radius,
    shape: recipe.shape,
    speed: recipe.speed,
    timing: recipe.timing,

    phase(cast, phase) {
      const scratch = at(built.scratch, cast);
      const drawables = at(built.drawables, cast);
      if (phase === "charge") {
        scratch.sinceImpact = 0;
        scratch.emitTimer = 0;
        return;
      }
      if (phase === "impact") {
        scratch.sinceImpact = 0;
        scratch.emitTimer = 0;
        land(world, drawables, recipe, cast, sky, lightColour, shellColour);
        emit(built.burst, recipe.burst, cast.pos, recipe.burst?.burst ?? 0);
        return;
      }
      if (phase === "linger") {
        emit(built.linger, recipe.linger, cast.pos, recipe.linger?.burst ?? 0);
        return;
      }
      // Retired: put every drawable this cast owns away. The floor mark belongs to the world.
      drawables.core.hide();
      drawables.shell.hide();
      drawables.bolt.hide();
    },

    update(cast, dt) {
      const scratch = at(built.scratch, cast);
      const drawables = at(built.drawables, cast);
      if (cast.phase === "charge") {
        position.copy(cast.from);
        chargeUp(drawables, recipe, position, cast.t / Math.max(1e-4, cast.durations.charge));
        emit(built.charge, recipe.charge, position, (recipe.charge?.burst ?? 0) * dt * 60);
        return;
      }
      if (cast.phase === "travel") {
        position.copy(cast.pos);
        drawBall(drawables, recipe, position);
        emit(built.trail, recipe.trail, position, (recipe.trail?.burst ?? 0) * dt * 60);
        if (recipe.bolt !== undefined) {
          sky.copy(cast.pos).setY(cast.pos.y + recipe.bolt.height);
          drawBolt(drawables, recipe, sky, cast.pos, 1, world.camera);
        }
        return;
      }
      scratch.sinceImpact += dt;
      stepImpact(drawables, recipe, cast, scratch.sinceImpact, world.camera);
      if (cast.phase === "linger") {
        scratch.emitTimer += dt;
        const interval = Math.max(0.02, recipe.linger?.interval ?? 0.12);
        if (scratch.emitTimer >= interval) {
          // One emission per interval, never a backlog: a long frame must not spend the burst twice.
          scratch.emitTimer = 0;
          emit(built.linger, recipe.linger, cast.pos, recipe.linger?.burst ?? 0);
        }
      }
    },
  };
}

/** Build every pool slot's drawables and the four emitters. Called once, at `create`. */
function build(world: SpellWorld, recipe: ISpellRecipe): IBuilt {
  const table = new ParticleKindTable(
    uniqueKinds([recipe.charge, recipe.trail, recipe.burst, recipe.linger]),
  );
  for (const kind of table.kinds) {
    table.set(kind, {
      colour: [recipe.tint.colour.r, recipe.tint.colour.g, recipe.tint.colour.b],
      highlight: [recipe.tint.highlight.r, recipe.tint.highlight.g, recipe.tint.highlight.b],
    });
  }
  return {
    burst: buildEmitter(world, table, recipe.burst, recipe.name, 1),
    charge: buildEmitter(world, table, recipe.charge, recipe.name, 2),
    drawables: Array.from({ length: world.castSlots }, () => createDrawables(world.scene)),
    linger: buildEmitter(world, table, recipe.linger, recipe.name, 3),
    scratch: Array.from({ length: world.castSlots }, () => ({ emitTimer: 0, sinceImpact: 0 })),
    trail: buildEmitter(world, table, recipe.trail, recipe.name, 4),
  };
}

/** Land the impact: the flash, the shell, the mark and the shake. */
function land(
  world: SpellWorld,
  drawables: ISpellDrawables,
  recipe: ISpellRecipe,
  cast: ICast,
  sky: Vector3,
  lightColour: Color,
  shellColour: Color,
): void {
  const impact = recipe.impact;
  if (impact.light !== undefined) {
    const light = impact.light;
    // The limiter can refuse a flash. The spell still lands; only the flash does not happen.
    if (world.flash()) {
      lightColour.copy(recipe.tint.colour).lerp(recipe.tint.highlight, 0.4);
      world.lights.flash({
        color: lightColour,
        intensity: light.intensity,
        range: light.range,
        seconds: light.seconds,
        x: cast.pos.x,
        y: cast.pos.y,
        z: cast.pos.z,
      });
    }
  }
  if (impact.splat !== undefined) {
    const splat = impact.splat;
    world.reaction?.splat({
      char: splat.char,
      crack: splat.crack,
      frost: splat.frost,
      glow: splat.glow,
      heat: splat.heat,
      pattern: splat.pattern ?? "radial",
      radius: splat.radius,
      seed: cast.seed,
      wet: splat.wet,
      x: cast.pos.x,
      z: cast.pos.z,
    });
  }
  if (impact.shake !== undefined && impact.shake > 0) world.shake?.trigger();
  if (recipe.bolt !== undefined) {
    sky.copy(cast.pos).setY(cast.pos.y + recipe.bolt.height);
    drawBolt(drawables, recipe, sky, cast.pos, 1, world.camera);
  }
  if (impact.shell !== undefined) {
    shellColour.copy(recipe.tint.colour).lerp(recipe.tint.highlight, 0.5);
    drawables.shell.show(cast.pos, 0.02, impact.shell.radius, shellColour, impact.shell.strength);
  }
  drawables.core.hide();
}

/** Advance the shell and the bolt through the impact and the linger. */
function stepImpact(
  drawables: ISpellDrawables,
  recipe: ISpellRecipe,
  cast: ICast,
  sinceImpact: number,
  camera: { readonly position: Vector3 } | undefined,
): void {
  const shell = recipe.impact.shell;
  if (shell !== undefined) {
    const colour = recipe.tint.colour.clone().lerp(recipe.tint.highlight, 0.5);
    if (shell.hold === true) {
      // A held shell does not expand: it sits at its radius and pulses until the cast retires.
      const pulse = 0.9 + 0.1 * Math.sin(sinceImpact * 9);
      drawables.shell.show(cast.pos, 0.999, shell.radius, colour, shell.strength * pulse, 1);
    } else {
      const progress = Math.min(1, sinceImpact / Math.max(0.05, shell.seconds));
      drawables.shell.show(cast.pos, progress, shell.radius, colour, shell.strength);
    }
  }
  const bolt = recipe.bolt;
  if (bolt !== undefined) {
    const life = Math.min(1, sinceImpact / Math.max(0.05, bolt.seconds));
    const sky = new Vector3(cast.pos.x, cast.pos.y + bolt.height, cast.pos.z);
    drawBolt(drawables, recipe, sky, cast.pos, 1 - life, camera);
  }
}

function drawBall(drawables: ISpellDrawables, recipe: ISpellRecipe, at: Vector3): void {
  const core = recipe.core;
  if (core === undefined) return;
  drawables.core.show(at, core.radius, recipe.tint.colour, recipe.tint.highlight, core.intensity);
}

function chargeUp(
  drawables: ISpellDrawables,
  recipe: ISpellRecipe,
  at: Vector3,
  progress: number,
): void {
  const core = recipe.core;
  if (core === undefined) return;
  const eased = Math.min(1, Math.max(0, progress));
  drawables.core.show(
    at,
    core.radius * (0.25 + 0.75 * eased),
    recipe.tint.colour,
    recipe.tint.highlight,
    core.intensity * eased,
  );
}

function drawBolt(
  drawables: ISpellDrawables,
  recipe: ISpellRecipe,
  from: Vector3,
  to: Vector3,
  strength: number,
  camera: { readonly position: Vector3 } | undefined,
): void {
  const bolt = recipe.bolt;
  if (bolt === undefined || strength <= 0.001) {
    drawables.bolt.hide();
    return;
  }
  drawables.bolt.show(
    from,
    to,
    bolt.width,
    recipe.tint.highlight,
    recipe.tint.colour,
    strength,
    0.37,
    camera,
  );
}

function buildEmitter(
  world: SpellWorld,
  table: ParticleKindTable,
  role: ISpellEmitter | undefined,
  name: string,
  seedOffset: number,
): GPUParticles3D | undefined {
  if (role === undefined) return undefined;
  const options = createParticleKindEmitter({
    // burst is particles per emission and may be fractional (a trail emits 2.4 per frame), but a
    // ring capacity is a whole number of slots.
    amount: Math.max(64, Math.ceil(role.burst * 64)),
    kind: role.kind,
    seed: seedOffset * 1013 + hashName(name),
    style: role.style,
    table,
  });
  const particles = new GPUParticles3D(options);
  particles.name = `${name}-${role.kind}-${seedOffset}`;
  world.add(particles);
  return particles;
}

function emit(
  emitter: GPUParticles3D | undefined,
  role: ISpellEmitter | undefined,
  at: Vector3,
  count: number,
): void {
  if (emitter === undefined || role === undefined) return;
  emitter.emitParticle({ count: Math.max(1, Math.round(count)), origin: at });
}

function uniqueKinds(roles: readonly (ISpellEmitter | undefined)[]): ParticleKindName[] {
  const kinds: ParticleKindName[] = [];
  for (const role of roles) {
    if (role !== undefined && !kinds.includes(role.kind)) kinds.push(role.kind);
  }
  return kinds.length > 0 ? kinds : ["spark"];
}

function at<T>(list: readonly T[], cast: ICast): T {
  const value = list[cast.index];
  if (value === undefined) throw new RangeError(`cast slot ${cast.index} is outside the pool`);
  return value;
}

/** A small stable hash of a name, so two spells' emitters do not share a random stream. */
function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 8;
}
