// Generated for you. Snowfall, the blizzard and the powder a boot kicks up. `GPUParticles3D` (the
// scene passes it in) owns
// the buffers, dispatch and lifetime; the flake's shape, colour, size, drift and fall are here.
import { type Sprite, Vector2 } from "three";
import {
  Fn,
  atan,
  cameraPosition,
  cos,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  mod,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
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
} from "three/webgpu";

/** Half the width of the box of air around the explorer that flakes fall through, metres. */
const SPAN = 21;
const CEILING = 19;
/** The widest a flake may be drawn, in screen pixels — the study's point-size clamp. */
const MAX_FLAKE_PIXELS = 24;
const BURST_PARTICLES = 96;
const BURST_LIFETIME = 1.05;

const random = (salt: number) => hash(instanceIndex.add(salt));

/** What a particle mechanism takes: a pool size, a sprite material and two compute passes. */
export interface IParticleOptions {
  readonly amount: number;
  readonly material: SpriteNodeMaterial;
  readonly start: (buffers: { readonly positions: StorageBufferNode<"vec3"> }) => ComputeNode;
  readonly process: (buffers: { readonly positions: StorageBufferNode<"vec3"> }) => ComputeNode;
}

/** The pooled sprite the scene builds from those options — `GPUParticles3D` in this game. */
export type ParticleSystem = Sprite & {
  readonly buffers: { readonly positions: StorageBufferNode<"vec3"> };
};

export interface ISnowWeather {
  readonly snowfall: ParticleSystem;
  readonly bursts: readonly ParticleSystem[];
  /** Live wind at the snowfield, m/s, gusts included. */
  readonly wind: number;
  /** 0 clear .. 1 blizzard, eased. */
  readonly storm: number;
  update(
    dt: number,
    centre: { readonly x: number; readonly z: number },
    /** Screen pixels per metre at one metre from the camera: `height / (2 tan(fov / 2))`. */
    pixelScale: number,
    settings: {
      readonly blizzard: boolean;
      readonly snowfall: number;
      readonly fallSpeed: number;
      readonly wind: number;
    },
  ): void;
  /** Kick up powder where a boot landed, deeper prints throwing more. */
  burst(at: { readonly x: number; readonly y: number; readonly z: number }, strength: number): void;
}

const floatUniform = (value: number) => uniform(value);
type FloatUniform = ReturnType<typeof floatUniform>;

/**
 * The flake sprite. `at` is each flake's world position and `pixelScale` the screen's pixels per
 * metre at one metre: a flake is never drawn wider than `MAX_FLAKE_PIXELS`, and fades out right
 * in front of the lens, so the air between the camera and the forest never turns to haze.
 */
function flakeMaterial(
  storm: FloatUniform,
  visible: FloatUniform,
  at: Node<"vec3">,
  pixelScale: FloatUniform,
) {
  const material = new SpriteNodeMaterial({
    blending: NormalBlending,
    depthWrite: false,
    transparent: true,
  });
  // A soft disc with six faint arms, squashed sideways as the storm drives it.
  const p = uv()
    .sub(0.5)
    .mul(vec2(float(1).sub(storm.mul(0.32)), 1));
  const r = p.length();
  const disc = exp(r.mul(r).mul(-18)).mul(float(1).sub(smoothstep(0.36, 0.5, r)));
  const arms = pow(cos(atan(p.y, p.x).mul(3)).abs(), 12)
    .mul(0.2)
    .add(0.8);
  const shown = step(float(instanceIndex).add(1), visible);
  const distance = cameraPosition.distance(at);
  const opacity = random(11)
    .mul(0.55)
    .add(0.28)
    .mul(smoothstep(0.35, 1.2, distance));
  material.colorNode = vec4(0.95, 0.977, 1, disc.mul(arms).mul(opacity).mul(shown));
  const size = pow(random(13), 3).mul(0.063).add(0.016);
  const widest = distance.mul(MAX_FLAKE_PIXELS).div(pixelScale);
  // In a storm each flake streaks along the wind, the study's squashed-disc look made longer.
  const drawn = size.mul(storm.mul(0.5).add(1)).min(widest).mul(shown);
  material.scaleNode = vec2(drawn.mul(storm.mul(1.6).add(1)), drawn);
  return material;
}

/**
 * Every flake's position is a function of how far the air has carried it, not a stored velocity:
 * `drift` and `fall` are integrated on the CPU from the live wind and fall speed, so changing a
 * slider never teleports the flakes, and the box wraps around the explorer wherever they walk.
 */
function createSnowfall(
  amount: number,
  particlesFor: (options: IParticleOptions) => ParticleSystem,
) {
  const storm = floatUniform(0);
  const visible = floatUniform(amount);
  const drift = uniform(new Vector2());
  const fall = uniform(0);
  const centre = uniform(new Vector2());
  const swirl = uniform(0);
  const pixelScale = floatUniform(800);
  const place = (positions: StorageBufferNode<"vec3">): ComputeNode =>
    Fn(() => {
      const seed = random(3).mul(100);
      const start = vec3(random(5), random(7), random(9));
      const speed = fract(seed).add(0.58);
      const height = mod(start.y.mul(CEILING).sub(fall.mul(speed)), CEILING).sub(0.5);
      const phase = swirl.add(seed);
      // Air near the ground is slower than air aloft, as the study's coupling had it.
      const coupling = height.div(7).clamp(0.18, 1);
      const wander = vec2(
        sin(phase.add(start.z.mul(4))),
        cos(phase.mul(0.86).add(start.x.mul(4))),
      ).mul(storm.mul(0.7).add(0.16));
      const span = float(SPAN * 2);
      const raw = start.xz.mul(span).add(drift.mul(coupling)).add(wander);
      const wrapped = mod(raw.sub(centre).add(SPAN), span).sub(SPAN).add(centre);
      positions.element(instanceIndex).assign(vec3(wrapped.x, height, wrapped.y));
    })().compute(amount);
  const material = new SpriteNodeMaterial();
  const particles = particlesFor({
    amount,
    material,
    process: ({ positions }) => place(positions),
    start: ({ positions }) => place(positions),
  });
  // The flake look needs each flake's position, which exists once the particle buffers do.
  const flake = flakeMaterial(
    storm,
    visible,
    particles.buffers.positions.toAttribute(),
    pixelScale,
  );
  flake.positionNode = material.positionNode;
  particles.material = flake;
  particles.renderOrder = 3;
  return { centre, drift, fall, particles, pixelScale, storm, swirl, visible };
}

/** One pooled burst: every particle leaves the boot at once and fades by its own lifetime. */
function createBurst(particlesFor: (options: IParticleOptions) => ParticleSystem) {
  const age = uniform(BURST_LIFETIME);
  const kick = uniform(1);
  const wind = uniform(0);
  const material = new SpriteNodeMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const life = random(17).mul(0.65).add(0.38);
  const t = age.min(life);
  const fade = float(1).sub(t.div(life)).max(0);
  const p = uv().sub(0.5);
  const puff = exp(p.dot(p).mul(-16)).mul(float(1).sub(smoothstep(0.34, 0.5, p.length())));
  const alive = step(age, life);
  material.colorNode = vec4(0.9, 0.94, 1, puff.mul(pow(fade, 1.5)).mul(0.5).mul(alive));
  material.scaleNode = vec2(random(19).mul(0.048).add(0.025).mul(t.div(life).mul(1.9).add(1)));
  const place = (positions: StorageBufferNode<"vec3">): ComputeNode =>
    Fn(() => {
      const angle = random(23).mul(Math.PI * 2);
      const outward = random(29).mul(0.58).add(0.22).mul(kick);
      const rise = random(31).mul(0.85).add(0.4).mul(kick);
      const launch = vec3(cos(angle).mul(0.13), 0.035, sin(angle).mul(0.2));
      const across = vec3(cos(angle).mul(outward).add(wind.mul(0.12)), 0, sin(angle).mul(outward));
      // Air drag slows the spray; gravity brings it back to the snow, where it rests.
      const travelled = float(1)
        .sub(exp(t.mul(-1.8)))
        .div(1.8);
      const height = rise.mul(t).sub(t.mul(t).mul(1.25)).max(0);
      positions
        .element(instanceIndex)
        .assign(launch.add(across.mul(travelled)).add(vec3(0, height, 0)));
    })().compute(BURST_PARTICLES);
  const particles = particlesFor({
    amount: BURST_PARTICLES,
    material,
    process: ({ positions }) => place(positions),
    start: ({ positions }) => place(positions),
  });
  particles.renderOrder = 4;
  particles.visible = false;
  return { age, kick, particles, wind };
}

export function createWeather(options: {
  readonly flakes: number;
  /** Builds a pooled particle system; the scene passes `GPUParticles3D`. */
  readonly particles: (options: IParticleOptions) => ParticleSystem;
}): ISnowWeather {
  const fall = createSnowfall(options.flakes, options.particles);
  const bursts = Array.from({ length: 8 }, () => createBurst(options.particles));
  let cursor = 0;
  let time = 0;
  let storm = 0;
  let wind = 0.4;
  let drifted = { x: 0, z: 0 };
  let fallen = 0;
  const damp = (a: number, b: number, rate: number, dt: number) =>
    a + (b - a) * (1 - Math.exp(-rate * Math.max(0, dt)));
  return {
    bursts: bursts.map((burst) => burst.particles),
    burst(at, strength) {
      const burst = bursts[cursor % bursts.length];
      cursor += 1;
      if (burst === undefined) return;
      burst.particles.position.set(at.x, at.y, at.z);
      burst.particles.visible = true;
      burst.age.value = 0;
      burst.kick.value = 0.8 + Math.min(1, strength * 4);
    },
    snowfall: fall.particles,
    get storm() {
      return storm;
    },
    update(dt, centre, pixelScale, settings) {
      fall.pixelScale.value = pixelScale;
      time += dt;
      storm = damp(storm, settings.blizzard ? 1 : 0, 0.95, dt);
      const gust = 1 + 0.22 * Math.sin(time * 1.1) + 0.12 * Math.sin(time * 2.73 + 1.6);
      const target = (settings.wind * (1 - storm) + (9.5 + settings.wind * 0.5) * storm) * gust;
      wind = damp(wind, target, 2.3, dt);
      drifted = { x: drifted.x + wind * dt, z: drifted.z + wind * 0.24 * dt };
      fallen += settings.fallSpeed * (0.95 + storm * 0.7) * dt;
      fall.drift.value.set(drifted.x, drifted.z);
      fall.fall.value = fallen;
      fall.swirl.value = time * 0.7;
      fall.centre.value.set(centre.x, centre.z);
      fall.storm.value = storm;
      fall.visible.value = Math.round(options.flakes * settings.snowfall * (0.24 + 0.76 * storm));
      for (const burst of bursts) {
        if (!burst.particles.visible) continue;
        burst.age.value += dt;
        burst.wind.value = wind;
        if (burst.age.value > BURST_LIFETIME) burst.particles.visible = false;
      }
    },
    get wind() {
      return wind;
    },
  };
}
