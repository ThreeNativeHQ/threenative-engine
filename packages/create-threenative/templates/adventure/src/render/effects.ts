// Generated for you. This is ordinary Three.js TSL — edit or delete it freely.
//
// The fight's feedback: ember sparks where the Ember Blade bites, cold white sparks where it
// clanks off stone or a thorned plate, and a burst off the shield when it turns a hit. Two pooled
// emitters cover every effect. `GPUParticles3D` (built in `scenes/Play.ts`) owns the slots, the
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

/** Hot orange-to-red sparks that fly wide and fall: a cut that lands. */
export function emberEffect(): IEffectOptions {
  return emitter({
    additive: true,
    amount: 384,
    colour: [
      [3, 1.5, 0.45],
      [1.4, 0.25, 0.03],
    ],
    drag: 2.4,
    gravity: -7,
    life: 0.55,
    mask: "star",
    opacity: 1,
    size: [0.3, 0.06],
  });
}

/** Cold white-blue sparks that die fast: a cut that clanks, a hit the shield turns. */
export function sparkEffect(): IEffectOptions {
  return emitter({
    additive: true,
    amount: 256,
    colour: [
      [2.6, 2.6, 2.4],
      [0.6, 0.9, 1.6],
    ],
    drag: 3.5,
    gravity: -4,
    life: 0.35,
    mask: "star",
    opacity: 1,
    size: [0.42, 0.08],
  });
}

/** The two emitters `scenes/Play.ts` builds, by the name a burst picks one with. */
export const EFFECTS = {
  ember: emberEffect,
  spark: sparkEffect,
} as const;

/**
 * Every burst the game fires, by name: its emitter, how many particles and the request's
 * `direction` (outward speed, upward speed, start radius). Tune the feel here, not in `scenes/Play.ts`.
 */
export const BURSTS = {
  hit: { emitter: "ember", count: 28, shape: [3.2, 2.4, 0.2] },
  clank: { emitter: "spark", count: 20, shape: [3.6, 1.6, 0.15] },
  block: { emitter: "spark", count: 26, shape: [4, 1.2, 0.25] },
} as const;
