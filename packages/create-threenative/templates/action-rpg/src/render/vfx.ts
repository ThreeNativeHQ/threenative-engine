import {
  Fn,
  abs,
  atan,
  cos,
  cross,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  normalize,
  sin,
  smoothstep,
  time,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  type ComputeNode,
  SpriteNodeMaterial as SpriteMaterial,
  type SpriteNodeMaterial,
  type StorageBufferNode,
} from "three/webgpu";
import * as THREE from "three/webgpu";

export interface IActionRpgVfxBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
}

export interface IActionRpgVfxOptions {
  readonly amount: number;
  readonly material: SpriteNodeMaterial;
  readonly start: (buffers: IActionRpgVfxBuffers) => ComputeNode;
  readonly process: (buffers: IActionRpgVfxBuffers) => ComputeNode;
  readonly onCull?: "pause" | "clear";
}

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

function random(seed: number, salt: number) {
  return hash(instanceIndex.add(seed + salt));
}

function phase(recipe: DonorRecipe, seed: number) {
  const lifetime = float(recipe.lifetime[0]).add(
    random(seed, 13).mul(recipe.lifetime[1] - recipe.lifetime[0]),
  );
  return fract(time.div(lifetime).add(random(seed, 19)));
}

function spawnPosition(recipe: DonorRecipe, seed: number) {
  const lineStart = recipe.lineStart ?? [0, 0, 0];
  const lineEnd = recipe.lineEnd ?? [0, 0, 0];
  const along = random(seed, 3);
  if (recipe.shape === "line") {
    return vec3(...lineStart)
      .mul(float(1).sub(along))
      .add(vec3(...lineEnd).mul(along));
  }
  const angle = random(seed, 7).mul(TAU);
  const radius = random(seed, 11).sqrt().mul(recipe.radius);
  return vec3(
    cos(angle).mul(radius),
    sin(angle).mul(radius),
    random(seed, 17)
      .sub(0.5)
      .mul(recipe.radius * 0.16),
  );
}

function launch(recipe: DonorRecipe, seed: number) {
  const speed = float(recipe.speed[0]).add(random(seed, 23).mul(recipe.speed[1] - recipe.speed[0]));
  const direction = normalize(vec3(...recipe.direction));
  const tangent = Math.abs(recipe.direction[1] ?? 1) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  const bitangent = normalize(cross(direction, tangent));
  const cone = float(recipe.cone).mul(random(seed, 29).sqrt());
  const azimuth = random(seed, 31).mul(TAU);
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
    blending: recipe.style === "glow" ? THREE.AdditiveBlending : THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const particlePhase = varying(phase(recipe, seed));
  const scale =
    recipe.shape === "line"
      ? vec2(
          Math.max(recipe.size * 3.8, recipe.lineEnd?.[0] ?? recipe.size),
          recipe.ribbonWidth ?? recipe.size,
        )
      : vec2(recipe.size);
  material.scaleNode = scale
    .mul(recipe.style === "glow" ? mix(1.08, 0.66, particlePhase) : mix(1.16, 0.36, particlePhase))
    .mul(0.52);
  material.colorNode = vec4(
    mix(vec3(...recipe.colour), vec3(...recipe.highlight), particlePhase),
    mask(recipe.style)
      .mul(float(1).sub(smoothstep(0.96, 1, particlePhase)))
      .mul(0.96),
  );
  const start = ({ positions, velocities }: IActionRpgVfxBuffers): ComputeNode =>
    Fn(() => {
      const spawn = spawnPosition(recipe, seed);
      positions.element(instanceIndex).assign(spawn);
      velocities.element(instanceIndex).assign(launch(recipe, seed));
    })().compute(recipe.amount);
  const process = ({ positions, velocities }: IActionRpgVfxBuffers): ComputeNode =>
    Fn(() => {
      const spawn = spawnPosition(recipe, seed);
      const velocity = launch(recipe, seed);
      const lifetime = float(recipe.lifetime[0]).add(
        random(seed, 13).mul(recipe.lifetime[1] - recipe.lifetime[0]),
      );
      const elapsed = phase(recipe, seed).mul(lifetime);
      const nextPosition = spawn
        .add(velocity.mul(elapsed))
        .add(vec3(...recipe.acceleration).mul(elapsed.mul(elapsed).mul(0.5)))
        .mul(exp(float(-recipe.drag).mul(elapsed)));
      positions.element(instanceIndex).assign(nextPosition);
      velocities.element(instanceIndex).assign(velocity);
    })().compute(recipe.amount);
  const direction = launch(recipe, seed);
  material.rotationNode = atan(direction.y, direction.x);
  // The kernels above derive every position from time, so a burst that left the view has no
  // buffer state to lose: it pauses and picks up where it was when the camera returns.
  return { amount: recipe.amount, material, start, process, onCull: "pause" };
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
