import { ACESFilmicToneMapping, AgXToneMapping, type Texture, type ToneMapping } from "three";
/** Game-owned biome choices; all five worlds share the same rendering and collision paths. */
import {
  abs,
  dot,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorldGeometry,
  positionWorld,
  rotateUV,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  GROUND_MAPS,
  type IGroundMaps,
  type LayerKey,
  ROCKFACE_MAPS,
} from "../world/terrainAssets.js";

export type WorldName = "forest" | "coastal" | "alpine" | "desert" | "tundra";
type RGB = readonly [number, number, number];

export interface IBiome {
  readonly world: WorldName;
  readonly grassTint: RGB;
  readonly stoneTint: RGB;
  readonly snowTint: RGB;
  readonly distantStone: RGB;
  readonly snow: readonly [number, number, number];
  readonly maps: Record<LayerKey, IGroundMaps>;
  readonly horizon: "mountain" | "alpine" | "mesa" | "plain";
  readonly sun: {
    readonly color: number;
    readonly intensity: number;
    readonly direction: RGB;
    readonly shadowRadius: number;
  };
  readonly sky: {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
  };
  readonly fill: { readonly sky: number; readonly ground: number; readonly intensity: number };
  readonly haze: {
    readonly color: number;
    readonly density: number;
    readonly valleyDensity: number;
    readonly height: number;
    readonly sunScatter: number;
  };
  readonly atmosphere: {
    readonly rayleigh: RGB;
    readonly mie: number;
    readonly radiance: number;
    readonly distanceScale: number;
    readonly horizonFade: readonly [number, number];
  };
  readonly skyRadiance: number;
  readonly saturation: number;
  readonly skySaturation: number;
  readonly exposure: number;
  /** The tone curve this world was graded under. */
  readonly toneMapping: ToneMapping;
  readonly clouds: number;
}

const temperate: IBiome = {
  world: "forest",
  grassTint: [0.43, 0.76, 0.38],
  stoneTint: [0.48, 0.44, 0.39],
  snowTint: [1, 1, 1],
  distantStone: [0.115, 0.105, 0.088],
  snow: [145, 195, 0.22],
  maps: GROUND_MAPS,
  horizon: "mountain",
  sun: { color: 0xffe3b5, intensity: 5.8, direction: [-180, 145, 80], shadowRadius: 1.7 },
  sky: { turbidity: 2, rayleigh: 3, mieCoefficient: 0.003, mieDirectionalG: 0.82 },
  fill: { sky: 0xa8c8e8, ground: 0x464937, intensity: 0.72 },
  haze: {
    color: 0x8ca8ba,
    density: 0.0011,
    valleyDensity: 0.000006,
    height: 120,
    sunScatter: 0.32,
  },
  atmosphere: {
    rayleigh: [0.005802, 0.013558, 0.0331],
    mie: 0.004,
    radiance: 1.4,
    distanceScale: 1.5,
    horizonFade: [400, 1500],
  },
  skyRadiance: 0.27,
  saturation: 1,
  skySaturation: 1,
  // +0.45 EV with TRAA (opaque foliage no longer averages with soil and sky), then +0.68 EV once the
  // sky image lost its baked sun: that disc had been 44% of the meadow's light.
  exposure: 2 ** 0.87,
  toneMapping: ACESFilmicToneMapping,
  clouds: 0.76,
};

export const BIOMES: Record<WorldName, IBiome> = {
  forest: temperate,
  coastal: {
    ...temperate,
    world: "coastal",
    sun: { ...temperate.sun, intensity: 5.2, direction: [-180, 150, -120] },
    fill: { ...temperate.fill, intensity: 0.66 },
    haze: { ...temperate.haze, density: 0.0008 },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.006,
      radiance: 1.4,
      distanceScale: 2,
      horizonFade: [500, 1200],
    },
    exposure: 2 ** -0.38,
    saturation: 0.93,
  },
  alpine: {
    ...temperate,
    world: "alpine",
    // ACES crushes the dark ridge rock in shadow to black; AgX keeps its detail.
    toneMapping: AgXToneMapping,
    horizon: "alpine",
    grassTint: [0.43, 0.8, 0.35],
    stoneTint: [0.86, 0.88, 0.9],
    snowTint: [1.9, 1.93, 2],
    distantStone: [0.23, 0.225, 0.215],
    snow: [50, 180, 0.39],
    maps: {
      ...GROUND_MAPS,
      snow: { ...GROUND_MAPS.snow, normal: "snow_02/snow_02_nor_gl_1k.jpg" },
      moss: { diffuse: GROUND_MAPS.moss.diffuse },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      rock: ROCKFACE_MAPS,
    },
    sun: { color: 0xffe7c7, intensity: 5.2, direction: [180, 130, 140], shadowRadius: 1.5 },
    sky: { turbidity: 1.3, rayleigh: 2.1, mieCoefficient: 0.0018, mieDirectionalG: 0.8 },
    haze: {
      color: 0x9aafc3,
      density: 0.0005,
      valleyDensity: 0.000009,
      height: 105,
      sunScatter: 0.28,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.002,
      radiance: 1.6,
      distanceScale: 1,
      horizonFade: [1800, 3300],
    },
    skyRadiance: 0.24,
    saturation: 0.86,
    skySaturation: 0.9,
    fill: { sky: 0xb2c6de, ground: 0x656963, intensity: 0.85 },
    clouds: 0.34,
  },
  desert: {
    ...temperate,
    world: "desert",
    horizon: "mesa",
    grassTint: [1, 1, 1],
    stoneTint: [1.16, 0.82, 0.55],
    distantStone: [0.31, 0.205, 0.12],
    snow: [10000, 10001, 0.22],
    maps: {
      ...GROUND_MAPS,
      grass: { ...GROUND_MAPS.sand, normal: "sand_01/sand_01_nor_gl_1k.jpg" },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      moss: {
        diffuse: "cliff_side/cliff_side_diff_1k.jpg",
        normal: "cliff_side/cliff_side_nor_gl_1k.jpg",
      },
      rock: {
        diffuse: "cliff_side/cliff_side_diff_1k.jpg",
        normal: "cliff_side/cliff_side_nor_gl_1k.jpg",
      },
    },
    sun: { color: 0xffe0ad, intensity: 6.2, direction: [160, 190, 85], shadowRadius: 1.1 },
    sky: { turbidity: 3.5, rayleigh: 1.4, mieCoefficient: 0.006, mieDirectionalG: 0.8 },
    fill: { sky: 0xc2d3db, ground: 0x9e7147, intensity: 0.32 },
    haze: {
      color: 0xd1b99b,
      density: 0.0011,
      valleyDensity: 0.000004,
      height: 90,
      sunScatter: 0.22,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.006,
      radiance: 1.35,
      distanceScale: 2.5,
      horizonFade: [500, 1100],
    },
    skyRadiance: 0.27,
    saturation: 0.94,
    exposure: 2 ** -0.52,
    clouds: 0.12,
  },
  tundra: {
    ...temperate,
    world: "tundra",
    horizon: "plain",
    grassTint: [0.83, 0.88, 0.82],
    stoneTint: [0.7, 0.74, 0.77],
    snowTint: [1.45, 1.5, 1.58],
    distantStone: [0.18, 0.2, 0.21],
    snow: [12, 36, 0.22],
    maps: {
      ...GROUND_MAPS,
      snow: { ...GROUND_MAPS.snow, normal: "snow_02/snow_02_nor_gl_1k.jpg" },
      grass: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
      },
      moss: {
        diffuse: "lichen_rock/lichen_rock_diff_512.jpg",
        normal: "lichen_rock/lichen_rock_nor_gl_512.jpg",
      },
    },
    sun: { color: 0xe9efff, intensity: 2.2, direction: [-180, 65, -120], shadowRadius: 2.1 },
    sky: { turbidity: 4.2, rayleigh: 1.6, mieCoefficient: 0.002, mieDirectionalG: 0.78 },
    fill: { sky: 0xb9ccdf, ground: 0x555851, intensity: 1.05 },
    haze: {
      color: 0xb1c0c9,
      density: 0.00065,
      valleyDensity: 0.000012,
      height: 35,
      sunScatter: 0.18,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.003,
      radiance: 1.2,
      distanceScale: 1.5,
      horizonFade: [500, 1200],
    },
    skyRadiance: 0.13,
    saturation: 0.96,
    exposure: 2 ** -0.28,
    clouds: 0.9,
  },
};

/** Local ground rules; slope keeps steep faces bare and noise breaks the snow's contour line. */
export function biomeWeights(
  biome: IBiome,
  steep: Node<"float">,
  hollow: Node<"float">,
  breakup: Node<"float">,
): Partial<Record<LayerKey, Node<"float">>> {
  if (biome.world === "forest" || biome.world === "coastal") return {};
  const drift = mx_fractal_noise_float(positionWorld.mul(0.033), 3);
  const stone = smoothstep(0.1, 0.29, steep.add(breakup.mul(0.04)));
  if (biome.world === "desert")
    return {
      dirt: smoothstep(0.14, 0.65, hollow).mul(0.7),
      moss: float(0),
      sand: float(0),
      rock: stone
        .max(smoothstep(25, 65, positionWorld.y).mul(0.48))
        .mul(float(1).sub(smoothstep(0.12, 0.5, hollow).mul(0.35))),
      snow: float(0),
    };
  // Wind-scoured convex/exposed faces shed snow; sheltered shelves keep it.
  const exposure = normalWorldGeometry.x.mul(0.65).add(normalWorldGeometry.z.mul(0.4)).max(0);
  const retention = smoothstep(
    biome.snow[0],
    biome.snow[1],
    positionWorld.y.add(hollow.max(0).mul(biome.world === "alpine" ? 14 : 5)),
  ).mul(
    float(1)
      .sub(smoothstep(biome.world === "alpine" ? 0.16 : 0.04, biome.snow[2], steep))
      .mul(float(1).sub(exposure.mul(0.28))),
  );
  // A narrow retention threshold leaves wind-shaped shelves and sharp scour edges.
  const snow = smoothstep(0.36, 0.42, retention.add(hollow.max(0).mul(0.08)));
  const cells = mx_worley_noise_vec2(
    vec3(positionWorld.x, 0, positionWorld.z).mul(0.13).add(drift.mul(0.35)),
  );
  const polygon = smoothstep(0.025, 0.11, cells.y.sub(cells.x));
  const mats = smoothstep(
    0.47,
    0.77,
    float(0.52)
      .add(positionWorld.x.mul(0.343).add(positionWorld.z.mul(0.1566)).sin().mul(0.27))
      .add(positionWorld.z.mul(0.3741).sub(positionWorld.x.mul(0.1666)).add(1.3).sin().mul(0.24))
      .add(positionWorld.x.mul(0.6958).add(positionWorld.z.mul(0.5307)).sin().mul(0.12)),
  );
  return {
    dirt:
      biome.world === "tundra"
        ? smoothstep(0.08, 0.5, hollow)
            .mul(0.28)
            .max(polygon.oneMinus().mul(0.3))
            .mul(mats.oneMinus())
        : smoothstep(0.08, 0.5, hollow).mul(0.55),
    moss:
      biome.world === "tundra"
        ? mats
            .mul(smoothstep(-0.2, 0.22, drift).mul(0.85).add(0.15))
            .mul(snow.oneMinus())
            .mul(mix(0.72, 0.98, polygon))
        : float(0),
    rock:
      biome.world === "alpine"
        ? stone
            .max(0.8)
            .max(smoothstep(40, 90, positionWorld.y).mul(0.58))
            .max(
              smoothstep(0.12, 0.5, hollow)
                .mul(smoothstep(35, 80, positionWorld.y))
                .mul(0.45),
            )
            .mul(float(1).sub(smoothstep(0.08, 0.4, hollow).mul(0.4)))
        : stone,
    snow: biome.world === "tundra" ? snow : alpineSnowCover(hollow),
  };
}

/** One world-space RockFace003 projection on both the massif and its protruding ribs. */
export function alpineRockTap(source: Texture, plane: Node<"vec2">, relief = false): Node<"vec4"> {
  const tap = (scale: number, angle: number, offset: Node<"vec2">) => {
    const sampled = texture(source, rotateUV(plane.div(scale), float(angle), vec2(0)).add(offset));
    if (!relief) return sampled;
    const tangent = rotateUV(sampled.xy.mul(2).sub(1), float(-angle), vec2(0));
    return vec4(tangent, sampled.z.mul(2).sub(1), 1);
  };
  const patch = smoothstep(-0.35, 0.35, mx_noise_float(positionWorld.mul(0.025)));
  return mix(tap(8, 0.17, vec2(0)), tap(32, -0.21, vec2(0.37, 0.61)), patch.mul(0.3).add(0.2));
}

export function alpineRockAlbedo(source: Texture): Node<"vec3"> {
  const axis = abs(normalWorldGeometry).pow(4);
  const share = axis.div(axis.x.add(axis.y).add(axis.z));
  return share.x
    .mul(alpineRockTap(source, positionWorld.zy).rgb)
    .add(share.y.mul(alpineRockTap(source, positionWorld.xz).rgb))
    .add(share.z.mul(alpineRockTap(source, positionWorld.xy).rgb));
}

export function alpineRockColor(sample: Node<"vec3">): Node<"vec3"> {
  const grey = dot(sample, vec3(0.2126, 0.7152, 0.0722));
  return mix(sample, vec3(grey), 0.25).mul(vec3(...BIOMES.alpine.stoneTint));
}

/** Snow respects world elevation and upward faces, including tilted instanced scans. */
export function alpineSnowCover(hollow: Node<"float"> = float(0)): Node<"float"> {
  const exposure = normalWorldGeometry.x.mul(0.65).add(normalWorldGeometry.z.mul(0.4)).max(0);
  const retention = smoothstep(50, 180, positionWorld.y.add(hollow.max(0).mul(110)))
    .mul(smoothstep(0.35, 0.72, normalWorldGeometry.y))
    .mul(float(1).sub(exposure.mul(0.28)))
    .mul(float(1).sub(hollow.min(0).negate().mul(0.65)));
  return smoothstep(0.36, 0.42, retention);
}

/** Thin sediment beds have varying thickness; varnish runs down, not around, a wall. */
export function desertRockColor(sample: Node<"vec3">): Node<"vec3"> {
  const grain = dot(sample, vec3(0.2126, 0.7152, 0.0722));
  const warp = mx_fractal_noise_float(positionWorld.mul(vec3(0.012, 0.003, 0.012)), 3).mul(5);
  const height = positionWorld.y.add(warp);
  const beds = mx_noise_float(vec3(0, height.mul(1.55), 0));
  const fine = height.mul(4.1).add(beds.mul(2.8)).sin().mul(0.05);
  const ledge = smoothstep(0.38, 0.62, mx_noise_float(vec3(0, height.mul(0.19), 0))).mul(0.18);
  const varnish = smoothstep(
    -0.18,
    0.28,
    mx_fractal_noise_float(positionWorld.mul(vec3(0.42, 0.004, 0.42)), 3),
  )
    .mul(normalWorldGeometry.y.abs().oneMinus())
    .mul(0.4);
  return vec3(1.52, 0.9, 0.5)
    .mul(grain)
    .mul(beds.mul(0.24).add(fine).add(1).sub(ledge))
    .mul(mix(vec3(1), vec3(0.55, 0.48, 0.42), varnish));
}
