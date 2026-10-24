// Generated for you. This is ordinary Three.js TSL — edit or delete it freely.
//
// The race's feedback: dust off the tyres, drift sparks that change colour as the mini-turbo
// charges (white, yellow, orange, as MK64's do), a flame out of the exhaust on every boost, and
// stars when a kart is hit or takes an item box. Six pooled emitters cover every effect.
// `GPUParticles3D` (built in `scenes/Race.ts`) owns the slots, the dispatch, the birth stamps and
// the culling. Every look choice is this file's: life, drag, gravity, size, colour, blend and
// sprite mask. A burst passes its shape as the request's `direction`: x is the outward speed,
// y the upward speed, and z the radius it starts in.
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

/** Pale grey-tan dust that billows and drifts up: tyre dust off-road, drift smoke, landings. */
export function dustEffect(): IEffectOptions {
  return emitter({
    additive: false,
    amount: 1024,
    colour: [
      [0.7, 0.64, 0.52],
      [0.9, 0.89, 0.86],
    ],
    drag: 3.5,
    gravity: 0.9,
    life: 0.8,
    mask: "puff",
    opacity: 0.5,
    size: [0.45, 1.3],
  });
}

/**
 * One drift-spark colour: additive stars thrown off the rear wheels, falling fast. The colours run
 * well above 1 because auto exposure meters a sunlit course: at 1.5 they vanish against the road.
 * Keep one channel low: overlapping additive stars sum, and a near-white birth colour reads white.
 */
function spark(birth: readonly [number, number, number], death: readonly [number, number, number]) {
  return emitter({
    additive: true,
    amount: 512,
    colour: [birth, death],
    drag: 2.5,
    gravity: -9,
    life: 0.35,
    mask: "star",
    opacity: 1,
    size: [0.55, 0.14],
  });
}

/** Stage 1: the slide is charging. White-blue, like MK64's first spark. */
export const sparkWhiteEffect = (): IEffectOptions => spark([1.2, 1.8, 4], [0.5, 1, 3]);
/** Stage 2: a release now fires the mini-turbo. Yellow. */
export const sparkYellowEffect = (): IEffectOptions => spark([3, 2, 0.15], [2.2, 1.1, 0.03]);
/** Stage 3: the top of the charge. Orange-red. */
export const sparkOrangeEffect = (): IEffectOptions => spark([3.2, 0.9, 0.08], [2.2, 0.25, 0.02]);

/**
 * The exhaust flame on a boost: hot yellow to red, short and bright, rising a little. Short-lived:
 * a puff stays where it was born while the kart runs on, so a longer life lays a dotted row of
 * lights down the road behind every boost.
 */
export function flameEffect(): IEffectOptions {
  return emitter({
    additive: true,
    amount: 512,
    colour: [
      [8, 5, 1.6],
      [4, 0.5, 0.06],
    ],
    drag: 6,
    gravity: 1.5,
    life: 0.12,
    mask: "puff",
    opacity: 0.95,
    size: [0.7, 0.2],
  });
}

/** Gold-white stars that pop out and fall: item boxes, hits, the finish line. */
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
    size: [0.4, 0.1],
  });
}

/** The six emitters `scenes/Race.ts` builds, by the name a burst picks one with. */
export const EFFECTS = {
  dust: dustEffect,
  flame: flameEffect,
  sparkOrange: sparkOrangeEffect,
  sparkWhite: sparkWhiteEffect,
  sparkYellow: sparkYellowEffect,
  sparkle: sparkleEffect,
} as const;

/**
 * Every burst the game fires, by name: its emitter, how many particles and the request's
 * `direction` (outward speed, upward speed, start radius). Tune the feel here, not in `scenes/Race.ts`.
 */
export const BURSTS = {
  /** Off-road: a puff from each rear tyre, scaled by speed in `Race.ts`. */
  grass: { emitter: "dust", count: 2, shape: [0.8, 1.2, 0.25] },
  drift: { emitter: "dust", count: 1, shape: [0.6, 0.8, 0.2] },
  landing: { emitter: "dust", count: 14, shape: [3, 0.5, 0.6] },
  wall: { emitter: "sparkle", count: 10, shape: [3.5, 2, 0.2] },
  // Drift sparks, one emitter per stage colour.
  spark1: { emitter: "sparkWhite", count: 3, shape: [2.2, 2.6, 0.15] },
  spark2: { emitter: "sparkYellow", count: 3, shape: [2.6, 3, 0.15] },
  spark3: { emitter: "sparkOrange", count: 4, shape: [3, 3.4, 0.15] },
  flame: { emitter: "flame", count: 3, shape: [0.5, 0.4, 0.08] },
  box: { emitter: "sparkle", count: 26, shape: [4, 4.5, 0.5] },
  hit: { emitter: "sparkle", count: 30, shape: [4.5, 5, 0.4] },
  splash: { emitter: "dust", count: 10, shape: [2.5, 3, 0.4] },
} as const satisfies Record<
  string,
  { emitter: keyof typeof EFFECTS; count: number; shape: readonly [number, number, number] }
>;
