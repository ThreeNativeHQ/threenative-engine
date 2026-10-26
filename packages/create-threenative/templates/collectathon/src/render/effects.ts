// Generated for you. This is ordinary Three.js TSL — edit or delete it freely.
//
// The moveset's feedback: dust under the feet, rings on landings, sparkles on pickups, flashes on
// impacts, pollen on the breeze. Four pooled emitters cover every effect. `GPUParticles3D` (built in `scenes/Play.ts`) owns the slots, the
// dispatch, the birth stamps and the culling. Every look choice is this file's: life, drag,
// gravity, size, colour, blend and sprite mask. A burst passes its shape as the request's
// `direction`: x is the outward speed, y the upward speed, and z the radius it starts in.
import {
  Fn,
  If,
  abs,
  cos,
  exp,
  float,
  hash,
  instanceIndex,
  mix,
  sin,
  smoothstep,
  step,
  time,
  uint,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  type ComputeNode,
  type Node,
  NormalBlending,
  SpriteNodeMaterial,
  type StorageBufferNode,
  type UniformNode,
  type Vector3,
} from "three/webgpu";

export interface IEffectBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
  readonly births: StorageBufferNode<"float">;
}

export interface IEffectRequest {
  readonly first: UniformNode<"uint", number>;
  readonly count: UniformNode<"uint", number>;
  readonly origin: UniformNode<"vec3", Vector3>;
  readonly direction: UniformNode<"vec3", Vector3>;
  readonly seed: UniformNode<"float", number>;
}

export interface IEffectOptions {
  readonly amount: number;
  readonly lifetime: number;
  readonly material: SpriteNodeMaterial;
  readonly spawn: (buffers: IEffectBuffers, request: IEffectRequest) => ComputeNode;
  readonly process: (
    buffers: IEffectBuffers,
    runtime: { readonly time: Node<"float">; readonly delta: Node<"float"> },
  ) => ComputeNode;
}

interface IRecipe {
  readonly amount: number;
  /** Seconds a particle lives. */
  readonly life: number;
  /** Fraction of speed lost per second, as an exponential rate. */
  readonly drag: number;
  /** Metres per second squared on y: negative falls, positive rises like warm dust. */
  readonly gravity: number;
  /** Sprite size in metres at birth and at death. */
  readonly size: readonly [number, number];
  /** Linear colour at birth and at death. */
  readonly colour: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly opacity: number;
  readonly additive: boolean;
  readonly mask: "puff" | "star";
}

const TAU = Math.PI * 2;

/** A soft round puff, or a four-point star with a soft core: no texture, no download. */
function sprite(mask: IRecipe["mask"]) {
  const point = uv().sub(0.5);
  const round = float(1).sub(smoothstep(0.05, 0.5, point.length()));
  if (mask === "puff") return round.mul(round);
  const ray = float(1)
    .sub(smoothstep(0.02, 0.07, abs(point.x)))
    .max(float(1).sub(smoothstep(0.02, 0.07, abs(point.y))))
    .mul(float(1).sub(smoothstep(0.1, 0.5, point.length())));
  return round.mul(round).max(ray);
}

function emitter(recipe: IRecipe): IEffectOptions {
  const material = new SpriteNodeMaterial({
    blending: recipe.additive ? AdditiveBlending : NormalBlending,
    depthWrite: false,
    transparent: true,
  });
  // The quad's empty corners write nothing to the depth and normal buffers, so AO skips them.
  material.alphaTest = 0.02;
  const [birth, death] = recipe.colour;
  // The material reads the birth stamp the engine writes, so it binds once the buffer exists.
  const bind = (born: Node<"float">): void => {
    const age = time.sub(born);
    const alive = varying(step(0, age).mul(step(age, recipe.life)));
    const phase = varying(age.div(recipe.life).clamp(0, 1));
    const jitter = hash(instanceIndex.add(7)).mul(0.6).add(0.7);
    material.scaleNode = mix(float(recipe.size[0]), float(recipe.size[1]), phase)
      .mul(jitter)
      .mul(alive);
    material.colorNode = vec4(
      mix(vec3(...birth), vec3(...death), phase),
      sprite(recipe.mask)
        .mul(float(1).sub(smoothstep(0.55, 1, phase)))
        .mul(recipe.opacity)
        .mul(alive),
    );
  };
  const spawn = (
    { positions, velocities, births }: IEffectBuffers,
    request: IEffectRequest,
  ): ComputeNode => {
    bind(births.toAttribute());
    return Fn(() => {
      If(instanceIndex.lessThan(request.count), () => {
        const slot = request.first.add(instanceIndex).mod(uint(recipe.amount));
        const key = instanceIndex.add(request.seed.mul(977).toUint());
        const r = (salt: number) => hash(key.add(salt));
        const angle = r(1).mul(TAU);
        const radius = r(2).sqrt().mul(request.direction.z);
        const out = request.direction.x.mul(r(3).mul(0.6).add(0.5));
        positions
          .element(slot)
          .assign(
            request.origin.add(
              vec3(cos(angle).mul(radius), r(4).mul(0.12), sin(angle).mul(radius)),
            ),
          );
        velocities
          .element(slot)
          .assign(
            vec3(
              cos(angle).mul(out),
              request.direction.y.mul(r(5).mul(0.8).add(0.6)),
              sin(angle).mul(out),
            ),
          );
      });
    })().compute(recipe.amount);
  };
  const process = (
    { positions, velocities, births }: IEffectBuffers,
    runtime: { readonly time: Node<"float">; readonly delta: Node<"float"> },
  ): ComputeNode =>
    Fn(() => {
      const age = runtime.time.sub(births.element(instanceIndex));
      If(age.greaterThanEqual(0).and(age.lessThan(recipe.life)), () => {
        const velocity = velocities
          .element(instanceIndex)
          .mul(exp(float(-recipe.drag).mul(runtime.delta)))
          .add(vec3(0, recipe.gravity, 0).mul(runtime.delta));
        velocities.element(instanceIndex).assign(velocity);
        positions.element(instanceIndex).addAssign(velocity.mul(runtime.delta));
      });
    })().compute(recipe.amount);
  return { amount: recipe.amount, lifetime: recipe.life, material, process, spawn };
}

/** Warm cream dust that billows, slows and drifts up: run puffs, landings, skids, poofs. */
export function dustEffect(): IEffectOptions {
  return emitter({
    additive: false,
    amount: 768,
    colour: [
      [0.72, 0.64, 0.5],
      [0.92, 0.9, 0.85],
    ],
    drag: 4,
    gravity: 0.8,
    life: 0.9,
    mask: "puff",
    // Light enough that the shoes read through a run's trail of puffs.
    opacity: 0.55,
    size: [0.41, 1.12],
  });
}

/** Hot white-to-amber flashes that burst wide and die fast: wall-kick sparks, the ground-pound ring. */
export function flashEffect(): IEffectOptions {
  return emitter({
    additive: true,
    amount: 256,
    // Warm, not white: overlapping additive stars brighter than this read as one glowing slab.
    colour: [
      [1.2, 0.9, 0.45],
      [0.8, 0.28, 0.04],
    ],
    drag: 3.5,
    gravity: -2,
    // 0.9 s, as long as a dust puff, so a kick's sparks still trail the hero off the wall.
    life: 0.9,
    mask: "star",
    opacity: 1,
    // Small and fast: the motion blur draws each one out into a streak.
    size: [0.35, 0.1],
  });
}

/** Gold-white stars that pop out and fall: pickups, wall-kick sparks, jump trails, gem glints. */
export function sparkleEffect(): IEffectOptions {
  return emitter({
    additive: true,
    amount: 512,
    colour: [
      [1.6, 1.45, 1.0],
      [1.2, 0.55, 0.08],
    ],
    drag: 2.2,
    gravity: -5,
    life: 0.9,
    mask: "star",
    opacity: 0.9,
    size: [0.32, 0.08],
  });
}

/** Petals and pollen that drift round the hero on the breeze, pale pink to cream. */
export function pollenEffect(): IEffectOptions {
  return emitter({
    additive: false,
    amount: 256,
    colour: [
      [1, 0.72, 0.82],
      [1, 0.95, 0.75],
    ],
    drag: 0.4,
    gravity: -0.06,
    life: 5,
    mask: "puff",
    opacity: 0.85,
    size: [0.11, 0.08],
  });
}

/** The four emitters `scenes/Play.ts` builds, by the name a burst picks one with. */
export const EFFECTS = {
  dust: dustEffect,
  flash: flashEffect,
  pollen: pollenEffect,
  sparkle: sparkleEffect,
} as const;

/**
 * Every burst the game fires, by name: its emitter, how many particles and the request's
 * `direction` (outward speed, upward speed, start radius). Tune the feel here, not in `scenes/Play.ts`.
 */
export const BURSTS = {
  run: { emitter: "dust", count: 4, shape: [0.9, 1.1, 0.3] },
  skid: { emitter: "dust", count: 16, shape: [2.6, 1, 0.35] },
  takeoff: { emitter: "dust", count: 12, shape: [2, 0.8, 0.3] },
  landing: { emitter: "dust", count: 24, shape: [3.6, 0.4, 0.4] },
  pound: { emitter: "dust", count: 39, shape: [8, 0.6, 0.5] },
  // A thin ring of sparks that skims out along the ground: almost no upward speed.
  poundRing: { emitter: "flash", count: 48, shape: [9, 0.15, 0.6] },
  debris: { emitter: "dust", count: 14, shape: [2.5, 6, 0.6] },
  ledge: { emitter: "dust", count: 6, shape: [0.8, 0.4, 0.3] },
  poof: { emitter: "dust", count: 24, shape: [2.6, 1.6, 0.4] },
  // A kick: 18 amber streaks off the wall plus 8 gold-white stars, slower than a pound's ring so
  // they stay round the hero; 10 streaks at 7 m/s were gone before the eye found them.
  wallKick: { emitter: "flash", count: 18, shape: [5, 2.5, 0.12] },
  kickStars: { emitter: "sparkle", count: 8, shape: [3, 2, 0.1] },
  trail: { emitter: "sparkle", count: 2, shape: [0.4, 0.3, 0.25] },
  streak: { emitter: "sparkle", count: 3, shape: [0.2, 0.1, 0.15] },
  coin: { emitter: "sparkle", count: 14, shape: [2.4, 3.5, 0.2] },
  gem: { emitter: "sparkle", count: 22, shape: [3, 4, 0.3] },
  seed: { emitter: "sparkle", count: 60, shape: [4.5, 6, 0.4] },
  glint: { emitter: "sparkle", count: 1, shape: [0.3, 0.8, 0.35] },
  pollen: { emitter: "pollen", count: 3, shape: [0.5, 0.35, 14] },
} as const satisfies Record<
  string,
  { emitter: keyof typeof EFFECTS; count: number; shape: readonly [number, number, number] }
>;
