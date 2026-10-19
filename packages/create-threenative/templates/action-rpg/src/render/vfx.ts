import {
  Fn,
  If,
  abs,
  atan,
  cos,
  cross,
  exp,
  float,
  hash,
  instanceIndex,
  mix,
  normalize,
  sin,
  smoothstep,
  step,
  time,
  uint,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  type ComputeNode,
  type Node,
  SpriteNodeMaterial as SpriteMaterial,
  type SpriteNodeMaterial,
  type StorageBufferNode,
  type UniformNode,
} from "three/webgpu";
import * as THREE from "three/webgpu";

/** `positions` hold world positions; `velocities` hold each particle's burst origin. */
export interface IActionRpgVfxBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
  readonly births: StorageBufferNode<"float">;
}

export interface IActionRpgVfxSpawnRequest {
  readonly first: UniformNode<"uint", number>;
  readonly count: UniformNode<"uint", number>;
  readonly origin: UniformNode<"vec3", THREE.Vector3>;
}

export interface IActionRpgVfxOptions {
  /** Ring capacity: room for `RING_BURSTS` overlapping bursts. Emit `burstCount` per hit. */
  readonly amount: number;
  readonly burstCount: number;
  /** Longest particle life in seconds, so the engine can report slots recycled while alive. */
  readonly lifetime: number;
  readonly material: SpriteNodeMaterial;
  readonly spawn: (
    buffers: IActionRpgVfxBuffers,
    request: IActionRpgVfxSpawnRequest,
  ) => ComputeNode;
  readonly process: (
    buffers: IActionRpgVfxBuffers,
    runtime: { readonly time: Node<"float"> },
  ) => ComputeNode;
  readonly onCull?: "pause" | "clear";
}

/** The ring holds this many overlapping bursts before a new one takes the oldest slots. */
const RING_BURSTS = 4;

type DonorRecipe = {
  readonly amount: number;
  readonly lifetime: readonly [number, number];
  readonly shape: "disc" | "line";
  readonly lineStart?: readonly [number, number, number];
  readonly lineEnd?: readonly [number, number, number];
  readonly radius: number;
  readonly direction: readonly [number, number, number];
  readonly speed: readonly [number, number];
  readonly cone: number;
  readonly size: number;
  readonly ribbonWidth?: number;
  readonly colour: readonly [number, number, number];
  readonly highlight: readonly [number, number, number];
  readonly style: "arc" | "glow" | "spark";
  readonly acceleration: readonly [number, number, number];
  readonly drag: number;
};

const TAU = Math.PI * 2;

/** Each burst reads its own random stream: the key is the engine's birth stamp of the slot. */
function burstKey(born: Node<"float">) {
  return born.max(0).mul(1000).toUint();
}

type Key = ReturnType<typeof burstKey>;

function random(seed: number, salt: number, key: Key) {
  return hash(instanceIndex.add(seed + salt).add(key));
}

function lifetimeOf(recipe: DonorRecipe, seed: number, key: Key) {
  return float(recipe.lifetime[0]).add(
    random(seed, 13, key).mul(recipe.lifetime[1] - recipe.lifetime[0]),
  );
}

function spawnPosition(recipe: DonorRecipe, seed: number, key: Key) {
  const lineStart = recipe.lineStart ?? [0, 0, 0];
  const lineEnd = recipe.lineEnd ?? [0, 0, 0];
  const along = random(seed, 3, key);
  if (recipe.shape === "line") {
    return vec3(...lineStart)
      .mul(float(1).sub(along))
      .add(vec3(...lineEnd).mul(along));
  }
  const angle = random(seed, 7, key).mul(TAU);
  const radius = random(seed, 11, key).sqrt().mul(recipe.radius);
  return vec3(
    cos(angle).mul(radius),
    sin(angle).mul(radius),
    random(seed, 17, key)
      .sub(0.5)
      .mul(recipe.radius * 0.16),
  );
}

/**
 * The axis a burst's cone is built around `direction` with. It must not be parallel to `direction`:
 * `cross(direction, tangent)` is then zero, its `normalize` is NaN, every launch velocity is NaN, and
 * the three.js arm's GPU hangs on the first frame the NaN reaches a sprite (VK_ERROR_DEVICE_LOST).
 * The test is on the *normalised* direction, so `[0, 0.2, 0]` is straight up like `[0, 1, 0]`.
 */
export function launchTangent(
  direction: readonly [number, number, number],
): readonly [number, number, number] {
  return Math.abs(direction[1] / Math.hypot(...direction)) > 0.9 ? [1, 0, 0] : [0, 1, 0];
}

function launch(recipe: DonorRecipe, seed: number, key: Key) {
  const speed = float(recipe.speed[0]).add(
    random(seed, 23, key).mul(recipe.speed[1] - recipe.speed[0]),
  );
  const direction = normalize(vec3(...recipe.direction));
  const tangent = vec3(...launchTangent(recipe.direction));
  const bitangent = normalize(cross(direction, tangent));
  const cone = float(recipe.cone).mul(random(seed, 29, key).sqrt());
  const azimuth = random(seed, 31, key).mul(TAU);
  return normalize(
    direction
      .mul(cos(cone))
      .add(tangent.mul(cos(azimuth)).mul(sin(cone)))
      .add(bitangent.mul(sin(azimuth)).mul(sin(cone))),
  ).mul(speed);
}

function mask(style: DonorRecipe["style"]) {
  const point = uv().sub(0.5);
  const radius = point.length();
  if (style === "spark") {
    const streak = float(1)
      .sub(smoothstep(0.018, 0.09, abs(point.y)))
      .mul(float(1).sub(smoothstep(0.12, 0.5, abs(point.x))));
    return float(1)
      .sub(smoothstep(0.05, 0.5, radius))
      .max(streak);
  }
  if (style === "glow") {
    return float(1)
      .sub(smoothstep(0.08, 0.56, radius))
      .add(float(0.2).mul(float(1).sub(smoothstep(0.01, 0.2, radius))));
  }
  const crossRay = float(1)
    .sub(smoothstep(0.018, 0.09, abs(point.x)))
    .max(float(1).sub(smoothstep(0.018, 0.09, abs(point.y))));
  const diagonal = float(1)
    .sub(smoothstep(0.018, 0.075, abs(point.x.sub(point.y))))
    .max(float(1).sub(smoothstep(0.018, 0.075, abs(point.x.add(point.y)))));
  return float(1)
    .sub(smoothstep(0.08, 0.5, radius))
    .max(crossRay.max(diagonal).mul(smoothstep(0.5, 0.05, radius)));
}

function createDonorEmitter(recipe: DonorRecipe, seed: number): IActionRpgVfxOptions {
  const material = new SpriteMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const capacity = recipe.amount * RING_BURSTS;
  // The material reads the birth stamp the engine writes, so it binds once the engine has made the buffer.
  const bindMaterial = (born: Node<"float">): void => {
    const key = burstKey(born);
    const age = time.sub(born);
    const lifetime = lifetimeOf(recipe, seed, key);
    const alive = varying(step(0, age).mul(step(age, lifetime)));
    const particlePhase = varying(age.div(lifetime).clamp(0, 1));
    const scale =
      recipe.shape === "line"
        ? vec2(
            Math.max(recipe.size * 3.8, recipe.lineEnd?.[0] ?? recipe.size),
            recipe.ribbonWidth ?? recipe.size,
          )
        : vec2(recipe.size);
    material.scaleNode = scale
      .mul(
        recipe.style === "glow" ? mix(1.08, 0.66, particlePhase) : mix(1.16, 0.36, particlePhase),
      )
      .mul(0.52)
      .mul(alive);
    material.colorNode = vec4(
      mix(vec3(...recipe.colour), vec3(...recipe.highlight), particlePhase),
      mask(recipe.style)
        .mul(float(1).sub(smoothstep(0.96, 1, particlePhase)))
        .mul(0.96)
        .mul(alive),
    );
    const direction = launch(recipe, seed, key);
    material.rotationNode = atan(direction.y, direction.x);
  };
  const spawn = (
    { positions, velocities, births }: IActionRpgVfxBuffers,
    request: IActionRpgVfxSpawnRequest,
  ): ComputeNode => {
    bindMaterial(births.toAttribute());
    return Fn(() => {
      If(instanceIndex.lessThan(request.count), () => {
        const slot = request.first.add(instanceIndex).mod(uint(capacity));
        velocities.element(slot).assign(request.origin);
        positions.element(slot).assign(request.origin);
      });
    })().compute(capacity);
  };
  const process = (
    { positions, velocities, births }: IActionRpgVfxBuffers,
    runtime: { readonly time: Node<"float"> },
  ): ComputeNode =>
    Fn(() => {
      const born = births.element(instanceIndex);
      const key = burstKey(born);
      const lifetime = lifetimeOf(recipe, seed, key);
      const elapsed = runtime.time.sub(born).clamp(0, lifetime);
      const local = spawnPosition(recipe, seed, key)
        .add(launch(recipe, seed, key).mul(elapsed))
        .add(vec3(...recipe.acceleration).mul(elapsed.mul(elapsed).mul(0.5)))
        .mul(exp(float(-recipe.drag).mul(elapsed)));
      positions.element(instanceIndex).assign(velocities.element(instanceIndex).add(local));
    })().compute(capacity);
  // A burst ages on the engine clock, so one that expires while the camera is away stays gone.
  // emitParticle still writes a burst emitted off-screen; it shows when the camera returns.
  return {
    amount: capacity,
    burstCount: recipe.amount,
    lifetime: recipe.lifetime[1],
    material,
    onCull: "pause",
    process,
    spawn,
  };
}

/** The attack arc uses the Kenney particle-pack slash-arc layer: line, width, colour and timing. */
export function createAttackArc(seed = 41): IActionRpgVfxOptions {
  return createDonorEmitter(
    {
      amount: 180,
      lifetime: [0.12, 0.28],
      shape: "line",
      lineStart: [-0.5, 0.12, -0.18],
      lineEnd: [0.5, 0.28, 0.18],
      radius: 0,
      direction: [0, 0.2, 0],
      speed: [0.15, 0.55],
      cone: 0.34,
      size: 0.08,
      ribbonWidth: 0.05,
      colour: [1, 0.98, 0.92],
      highlight: [1, 0.32, 0.08],
      style: "arc",
      acceleration: [0, 0, 0],
      drag: 0.06,
    },
    seed,
  );
}

/** The hit burst keeps the Effekseer impact-spark launch cone and falling acceleration. */
export function createHitBurst(seed = 53): IActionRpgVfxOptions {
  return createDonorEmitter(
    {
      amount: 220,
      lifetime: [0.23, 0.64],
      shape: "disc",
      radius: 0.08,
      direction: [0.05, 1, 0.04],
      speed: [5.704, 9.2],
      cone: Math.PI / 1.75,
      size: 0.09,
      colour: [1, 0.95, 0.82],
      highlight: [1, 0.34, 0.06],
      style: "spark",
      acceleration: [0, -8.5, 0],
      drag: 0.22,
    },
    seed,
  );
}

/** The surge uses the WebGPU magic-beam line layer and its cyan glow palette. */
export function createArcaneSurge(seed = 67): IActionRpgVfxOptions {
  return createDonorEmitter(
    {
      amount: 240,
      lifetime: [0.704, 1.1],
      shape: "line",
      lineStart: [0, 0, -0.18],
      lineEnd: [0, 0, 0.18],
      radius: 0,
      direction: [1, 0.04, 0],
      speed: [0.52, 1.2],
      cone: 0.22,
      size: 0.14,
      ribbonWidth: 0.065,
      colour: [0.53, 1, 0.96],
      highlight: [0.08, 0.44, 1],
      style: "glow",
      acceleration: [0, 0.01, 0.02],
      drag: 0.04,
    },
    seed,
  );
}
