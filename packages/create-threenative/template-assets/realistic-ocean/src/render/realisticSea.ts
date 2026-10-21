// Generated for you. The realistic sea's tuning and its entire look live in these files, and
// ThreeNative does not read them. `SpectralOcean` runs the simulation and draws nothing; this file
// is the mesh, the material, the colours and the shading decisions, and every number in it is yours
// to change: the spectrum in `realisticSpectrum.ts`, the foam's memory in `realisticSeaMaps.ts`.
//
// What it adds to a plain spectral sea, each one adapted from web-ocean (MIT, Copyright (c) 2026
// Maksymilian Dendura; see REALISTIC-OCEAN-LICENSE.txt):
//  - a fetch-limited JONSWAP wind sea plus an independently directed swell, scaled to a target
//    significant wave height, with capillary dispersion at the short end;
//  - three cascades, so one frame holds a swell, a chop and a skin of ripples at once;
//  - slope-moment filtering: the slope a pixel is too far away to resolve is not thrown away, it is
//    spent as roughness, so the sun's glitter path widens with distance instead of vanishing or
//    shimmering;
//  - whitecaps that persist and age, from the Jacobian of the horizontal displacement;
//  - light coming through backlit crests.
//
// It composes with the scene it is in. Light, shadow, image-based reflection, fog and tone mapping
// are the scene's own: this is a standard node material, not a second lighting model.
import { type ISpectralOceanOptions, SpectralOcean } from "@threenative/core";
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  type Scene,
  Vector2,
  Vector3,
} from "three";
import {
  BRDF_Lambert,
  F_Schlick,
  Fn,
  V_GGX_SmithCorrelated,
  abs,
  cameraPosition,
  color,
  diffuseColor,
  dot,
  float,
  luminance,
  max,
  mix,
  mx_noise_float,
  normalView,
  normalWorld,
  oneMinus,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  positionWorld,
  pow,
  reference,
  roughness,
  saturate,
  smoothstep,
  transformNormalToView,
  uniform,
  uniformArray,
  vec2,
  vec3,
} from "three/tsl";
import type { Node, NodeBuilder } from "three/webgpu";
import { MeshStandardNodeMaterial, PhysicalLightingModel } from "three/webgpu";
import { SeaMaps, sampleBilinear, sampleBilinearFloat } from "./realisticSeaMaps.js";
import {
  type ISeaState,
  capillaryCrossover,
  seaEnergy,
  slopeVarianceTable,
} from "./realisticSpectrum.js";

/**
 * The sea state. Every number is this game's.
 *
 * `wind.fetch` and `wind.speed` set how long and how tall the wind sea is; `swell` is a second,
 * straighter-crested train that does not care where the wind is blowing; `waveHeight` scales the
 * whole thing so the sea is as tall as you say it is, whatever the grid resolution.
 */
// web-ocean's own sea: a 7 m/s wind sea over 90 km and a 1.8 m, 120 m swell. Directions are set
// against the sailing kit's sun (bearing -0.6 rad) the way web-ocean sets them against its own:
// the wind sea runs 204 degrees from the sun's bearing, the swell straight away from it, so
// looking into the sun is looking along the crests' faces, where glitter and backlight are.
export const SEA_STATE: ISeaState = {
  wind: { speed: 7, direction: 2.96, fetch: 90_000, peakEnhancement: 3.3 },
  swell: { height: 1.8, direction: 2.54, peakFrequency: 0.717, spreading: 48 },
  gravity: 9.81,
  surfaceTension: 7.4e-5,
  // web-ocean's 1.2 mm. Larger cuts into the ripples the finest cascade exists to carry.
  shortWaveCut: 0.0012,
  // The height web-ocean's own spectrum has at these inputs, unscaled: 2.3 m.
  waveHeight: 2.3,
};

/**
 * The cascades, largest patch first. Each one carries only the wavelengths the next-larger patch
 * cannot resolve, so no wave is counted twice. 256 / 48 / 9 metres on a 128 grid resolves from a
 * 4 m swell down to a 14 cm ripple. The first patch also sets the spacing of the CPU height copy
 * (`readbackResolution` over this), which is why it is not larger: a ship cannot float on a grid
 * coarser than it is long.
 */
export const SEA_CASCADES = [{ patchSize: 256 }, { patchSize: 48 }, { patchSize: 9 }] as const;

export const SEA = {
  cascades: SEA_CASCADES,
  resolution: 128,
  // Horizontal displacement scale. Above zero sharpens crests, which is also what folds them into
  // whitecaps, so it is the foam's input as much as the shape's.
  choppiness: 1.25,
  seed: 20_261_020,
  // 128 across a 256 m patch is one height every two metres. See `SEA_CASCADES`.
  readbackResolution: 128,
  readbackEveryFrames: 3,
  gravity: SEA_STATE.gravity,
  windSpeed: SEA_STATE.wind.speed,
  windDirection: SEA_STATE.wind.direction,
  // Ignored while `energy` is set, and required by the option list: there are no defaults.
  amplitude: 1,
  directionality: 1,
  smallWaveCutoff: SEA_STATE.shortWaveCut,
} satisfies Omit<ISpectralOceanOptions, "energy" | "capillaryWavenumber">;

/** The whitecaps' memory. */
export const FOAM = {
  /** Seconds for a patch of foam to halve. */
  halfLife: 3,
  /** Jacobian below which water is breaking. */
  threshold: 0.8,
  gain: 3,
  /** Foam grids ride on these cascades, finest first. The second is the coarse, far one. */
  cascades: [1, 0] as readonly number[],
} as const;

/** Looks: colours are linear RGB, sizes are metres. */
export const LOOK = {
  // web-ocean's coastal body colour (turbidity 1.6), lit the way a standard material lights it:
  // its scatter times 1.6 on the crests, half that in the troughs.
  deep: 0x275a62,
  shallow: 0x397d88,
  foam: 0xe6eef0,
  /** Light coming through a thin backlit crest, and how strongly. */
  subsurface: 0x356252,
  subsurfaceGain: 2.6,
  /**
   * Radiance of the sun for the crest glow only, until `setSun` is given the scene's key light.
   * The scene's own light lights everything else.
   */
  sunRadiance: [3.4, 3.1, 2.5] as readonly [number, number, number],
  /** Fraction of the mirrored hull and marks that shows. A render target is written linear. */
  mirrorGain: 0.55,
  /**
   * Mean-square slope of the capillary ripples no cascade carries, at any distance, plus what
   * grows in with distance (`far`, from `from` to `to` metres). Without it a near pixel is a
   * mirror: the sun lands on a few facets as pinpoints and the glitter path never forms.
   */
  capillarySlope: { near: 0.0048, far: 0.007, from: 30, to: 500 },
  /**
   * Where the sea stops being a skin of ripples and becomes sub-pixel slope, in metres of pixel.
   * The nearest footprint is the finest cascade's texel, measured off the sea: a pixel finer than
   * that still cannot see the ripples no cascade carries.
   */
  slopeTable: { count: 64, farthest: 400 },
} as const;

/** The disc's geometry: rings of quads whose spacing grows with radius, centred on the ship. */
export const SURFACE = { segments: 160, rings: 96, inner: 1.5, reach: 6_000 } as const;

/** How far astern a wake reaches, how fast it opens and how wide it is at the transom. */
export const WAKE = { length: 26, spread: 0.21, waist: 0.5 } as const;
/** The ring of broken water at a hull's waterline, as half its length and beam in metres. */
export const HULL_WASH = { halfBeam: 0.62, halfLength: 2.35 } as const;

/**
 * The one thing the material asks of a planar mirror. Structural, so the type is not an import.
 * Pass `undefined` to the surface for none; the image-based sky reflection stays.
 */
export interface ISeaMirror {
  reflectionAt(offset?: Node<"vec2">): Node<"vec3">;
  dispose(): void;
}

export interface IRealisticWaterSurface {
  readonly mesh: Mesh;
  /** Move the drawn sea to follow a position, keeping the waves anchored to the world. */
  follow(x: number, z: number): void;
  /** The sea's own clock, in seconds. */
  advance(elapsed: number): void;
  /** Where a hull is, which way it points and how hard it pushes water aside (0..1). */
  wake(x: number, z: number, forwardX: number, forwardZ: number, strength: number): void;
  /** Direction toward the sun (any length) and the radiance the crest glow uses. */
  setSun(
    direction: readonly [number, number, number],
    radiance?: readonly [number, number, number],
  ): void;
  /** Forget every whitecap, for a teleport or a restart. */
  reset(): void;
  dispose(): void;
}

/** The simulation. Hand it to `ctx.add` and it runs; it draws nothing. */
export function createRealisticSea(state: ISeaState = SEA_STATE): SpectralOcean {
  const patchSizes = SEA.cascades.map((cascade) => cascade.patchSize);
  return new SpectralOcean({
    ...SEA,
    cascades: SEA.cascades,
    windSpeed: state.wind.speed,
    windDirection: state.wind.direction,
    gravity: state.gravity,
    smallWaveCutoff: state.shortWaveCut,
    energy: seaEnergy(state, SEA.resolution, patchSizes),
    capillaryWavenumber: capillaryCrossover(state.gravity, state.surfaceTension),
  });
}

/** The derivative and foam grids the material reads. Add it to the scene after the sea. */
export function createRealisticMaps(ocean: SpectralOcean): SeaMaps {
  return new SeaMaps(ocean, {
    foamHalfLife: FOAM.halfLife,
    foamThreshold: FOAM.threshold,
    foamGain: FOAM.gain,
    foamCascades: FOAM.cascades,
  });
}

/** The logarithmic disc, in the sea patch's own space: one vertex at the centre, then the rings. */
function seaDisc(): BufferGeometry {
  const { inner, reach, rings, segments } = SURFACE;
  const growth = Math.log(1 + reach / inner) / rings;
  const positions: number[] = [0, 0, 0];
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const radius = inner * (Math.exp((ring + 1) * growth) - 1);
    for (let step = 0; step < segments; step += 1) {
      const angle = (step / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    }
  }
  for (let step = 0; step < segments; step += 1) {
    indices.push(0, 1 + ((step + 1) % segments), 1 + step);
  }
  for (let ring = 1; ring < rings; ring += 1) {
    for (let step = 0; step < segments; step += 1) {
      const near = 1 + (ring - 1) * segments + step;
      const nearNext = 1 + (ring - 1) * segments + ((step + 1) % segments);
      const far = 1 + ring * segments + step;
      const farNext = 1 + ring * segments + ((step + 1) % segments);
      indices.push(near, farNext, far, near, nearNext, farNext);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * three's physical model with three changes. Foam takes the sky's light as a bubble layer does,
 * below. The sun's highlight is Beckmann, the Gaussian slope
 * distribution sea slopes have: GGX's long tails spread the glitter path into a wide soft band.
 * The environment's mirror term is at the brightness the sky is drawn (`scene.backgroundIntensity`):
 * three scales it by `scene.environmentIntensity`, the fill a scene lights its objects with, which
 * can be lower. The water's body keeps that fill, like every other object.
 */
class SeaLightingModel extends PhysicalLightingModel {
  /** Where the surface is foam, 0 to 1. */
  readonly #foam: Node<"float">;

  constructor(foam: Node<"float">) {
    super();
    this.#foam = foam;
  }

  override direct(light: Parameters<PhysicalLightingModel["direct"]>[0]): void {
    const lightDirection = light.lightDirection as Node<"vec3">;
    const lightColor = light.lightColor as Node<"vec3">;
    const reflected = light.reflectedLight as unknown as Record<
      "directDiffuse" | "directSpecular",
      Node<"vec3">
    >;
    const dotNL = normalView.dot(lightDirection).clamp();
    const dotNV = normalView.dot(positionViewDirection).clamp(1e-4, 1);
    const half = lightDirection.add(positionViewDirection).normalize();
    const cos2 = normalView.dot(half).clamp(1e-4, 1).pow(2);
    const alpha = roughness.pow(2);
    const meanSquareSlope = alpha.pow(2);
    const beckmann = cos2
      .oneMinus()
      .div(cos2.mul(meanSquareSlope))
      .negate()
      .exp()
      .div(meanSquareSlope.mul(Math.PI).mul(cos2.pow(2)));
    const fresnel = F_Schlick({
      f0: float(0.02037),
      f90: float(1),
      dotVH: positionViewDirection.dot(half).clamp(),
    }) as unknown as Node<"float">;
    const visibility = V_GGX_SmithCorrelated({ alpha, dotNL, dotNV }) as unknown as Node<"float">;
    const irradiance = lightColor.mul(dotNL);
    const lambert = BRDF_Lambert({ diffuseColor: diffuseColor.rgb }) as unknown as Node<"vec3">;
    // Foam's lumpy surface shades half of a low sun on itself.
    reflected.directDiffuse.addAssign(irradiance.mul(lambert).mul(mix(1, 0.5, this.#foam)));
    reflected.directSpecular.addAssign(irradiance.mul(fresnel.mul(beckmann).mul(visibility)));
  }

  override indirectSpecular(builder: NodeBuilder): void {
    const context = builder.context as Record<"radiance" | "iblIrradiance", Node<"vec3">>;
    const radiance = context.radiance;
    const irradiance = context.iblIrradiance;
    const { scene } = builder as unknown as { scene: Scene };
    const drawn = reference("backgroundIntensity", "float", scene);
    const fill = reference("environmentIntensity", "float", scene);
    context.radiance = radiance.mul(drawn.div(fill.max(1e-4)));
    // Foam is a layer of bubbles that scatters the whole sky into the eye, about twice what one
    // Lambert surface returns, and mostly grey: the sky's colour averages out between the bubbles.
    const scattered = mix(irradiance, vec3(luminance(irradiance)), 0.85).mul(2);
    context.iblIrradiance = mix(irradiance, scattered, this.#foam);
    super.indirectSpecular(builder);
    context.radiance = radiance;
    context.iblIrradiance = irradiance;
  }
}

export interface IRealisticWaterOptions {
  /** A CPU rasteriser cannot draw the full graph fast enough for the height copy to land. */
  readonly software?: boolean;
  /** The spectrum the sea was built from, so the slope table matches it. Defaults to `SEA_STATE`. */
  readonly state?: ISeaState;
}

export function createRealisticWaterMesh(
  ocean: SpectralOcean,
  maps: SeaMaps,
  mirror: ISeaMirror | undefined,
  options: IRealisticWaterOptions = {},
): IRealisticWaterSurface {
  const cheap = options.software === true;
  const state = options.state ?? SEA_STATE;
  const geometry = seaDisc();
  const size = ocean.resolution;
  const cascadeCount = ocean.cascades.length;
  const patch = (c: number) => ocean.cascadePatchSize(c);
  const texel = (c: number) => patch(c) / size;

  const seaOrigin = uniform(new Vector2());
  const seaTime = uniform(0);
  const shipOrigin = uniform(new Vector2());
  const shipForward = uniform(new Vector2(0, -1));
  const wakeStrength = uniform(0);
  const sunDirection = uniform(new Vector3(0.4, 0.8, 0.3).normalize());
  const sunRadiance = uniform(new Vector3(...LOOK.sunRadiance));

  // The glitter table: the slope carried by everything a pixel is too far away to resolve.
  const slopeTable = { ...LOOK.slopeTable, nearest: texel(cascadeCount - 1) };
  const table = slopeVarianceTable(
    seaEnergy(
      state,
      size,
      ocean.cascades.map((_, c) => patch(c)),
    ),
    slopeTable,
  );
  // A uniform array, not a storage buffer: a device made with the default limits allows eight
  // storage buffers in the fragment stage, and the slope and foam grids below already use seven.
  const tableBuffer = uniformArray(Array.from(table), "float");

  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.2 });

  // The rest position of this fragment, straight from the disc's own attribute. `positionLocal` is
  // overwritten by `positionNode`, so reading it in the fragment would hand back the displaced one.
  const rest = vec2(
    positionGeometry.x.add(seaOrigin.x),
    positionGeometry.z.add(seaOrigin.y),
  ).toVarying();
  const restX = rest.x;
  const restZ = rest.y;

  // Geometry: the cascades the mesh can resolve. The finest is a few centimetres tall and only
  // matters beside the hull, so it fades out with distance rather than aliasing across the disc.
  const eye = cameraPosition.sub(positionWorld);
  const distance = eye.length();
  const rangeToRest = cameraPosition.sub(vec3(restX, 0, restZ)).length();
  const displacementAt = (c: number, weight: Node<"float">) =>
    sampleBilinear(ocean.cascadeDisplacement(c), size, patch(c), restX, restZ).xyz.mul(weight);
  let offset = displacementAt(0, float(1));
  for (let c = 1; c < cascadeCount; c += 1) {
    const fade =
      c === cascadeCount - 1 ? oneMinus(smoothstep(float(8), float(28), rangeToRest)) : float(1);
    offset = offset.add(displacementAt(c, fade));
  }
  material.positionNode = positionLocal.add(offset);

  // The pixel's size on the water as the square root of its area. At a grazing view a pixel is a
  // long thin strip: its long side would fade every crest running across the view and spend it as
  // roughness in all directions, which widens the glitter path sideways and blurs the far sea.
  const footprint = positionWorld.dFdx().length().mul(positionWorld.dFdy().length()).sqrt();

  // What a pixel can resolve: each cascade contributes its slope while the pixel is finer than the
  // cascade's own texel, and is faded out above that. The fade is not a loss: the table below hands
  // the same variance back as roughness.
  const surface = Fn(() => {
    const slope = vec2(0, 0).toVar();
    const jxx = float(0).toVar();
    const jzz = float(0).toVar();
    const jxz = float(0).toVar();
    for (let c = 0; c < cascadeCount; c += 1) {
      const weight = oneMinus(smoothstep(float(texel(c) * 0.5), float(texel(c) * 2), footprint));
      const read = sampleBilinear(maps.slope(c), size, patch(c), restX, restZ).mul(weight);
      slope.addAssign(read.xy);
      jxx.addAssign(read.z);
      jzz.addAssign(read.w);
      // The shear matters only where foam is drawn from the Jacobian; the finest cascade's is a
      // few millimetres and its buffer would be the ninth storage binding.
      if (FOAM.cascades.includes(c))
        jxz.addAssign(sampleBilinear(maps.shear(c), size, patch(c), restX, restZ).x.mul(weight));
    }
    const jx = max(jxx.add(1), 0.15);
    const jz = max(jzz.add(1), 0.15);
    const jacobian = jxx.add(1).mul(jzz.add(1)).sub(jxz.mul(jxz));
    return vec3(slope.x.div(jx), slope.y.div(jz), jacobian);
  })().toVar();

  const worldSlope = vec2(surface.x, surface.y);
  const jacobian = surface.z;

  if (!cheap) {
    material.normalNode = transformNormalToView(
      vec3(worldSlope.x.negate(), 1, worldSlope.y.negate()).normalize(),
    );
  }

  // The unresolved slope, as roughness. `alpha = sqrt(mean-square slope)`, and three's roughness is
  // `sqrt(alpha)`, so the fourth root of the table entry.
  const tableIndex = footprint
    .max(slopeTable.nearest)
    .div(slopeTable.nearest)
    .log()
    .div(Math.log(slopeTable.farthest / slopeTable.nearest))
    .clamp(0, 1)
    .mul(LOOK.slopeTable.count - 1);
  const lower = tableIndex.floor();
  const entry = (index: Node<"uint">) => tableBuffer.element(index) as unknown as Node<"float">;
  const unresolved = mix(
    entry(lower.toUint()),
    entry(
      lower
        .add(1)
        .min(LOOK.slopeTable.count - 1)
        .toUint(),
    ),
    tableIndex.sub(lower),
  );

  // Foam: persistent grids, near (fine) and far (coarse), thresholded by a tearing pattern so it is
  // patches with water between them rather than a decal.
  const nearFoam = sampleBilinearFloat(
    maps.foam(0),
    size,
    patch(FOAM.cascades[0] as number),
    restX,
    restZ,
  );
  const farFoam = sampleBilinearFloat(
    maps.foam(1),
    size,
    patch(FOAM.cascades[1] as number),
    restX,
    restZ,
  );
  const foamBlend = smoothstep(float(60), float(220), distance);
  const fresh = saturate(float(FOAM.threshold).sub(jacobian).mul(FOAM.gain));
  // Breaking water is on the crests: foam from the grids is gated to the part of the surface above
  // the mean level, so it sits on tops of waves instead of lying in troughs as confetti.
  const crestGate = smoothstep(
    float((state.waveHeight ?? 1) * -0.05),
    float((state.waveHeight ?? 1) * 0.12),
    positionWorld.y,
  );
  // A crest breaking now is on a crest wherever the swell has carried it, so only the grids' older
  // foam is gated.
  const cover = max(
    mix(nearFoam, farFoam, foamBlend).mul(crestGate),
    fresh.mul(oneMinus(foamBlend)),
  );
  const pattern = Fn(() => {
    const p = vec2(restX, restZ);
    const a = mx_noise_float(vec3(p.mul(0.9), seaTime.mul(0.05)));
    const b = mx_noise_float(vec3(p.mul(2.7), seaTime.mul(0.08)));
    const c = mx_noise_float(vec3(p.mul(8.1), 0));
    return a.mul(0.5).add(b.mul(0.3)).add(c.mul(0.2)).mul(0.5).add(0.5);
  })();
  const edge = pattern.fwidth().add(0.03);
  const soft = float(0.05).add(oneMinus(saturate(cover)).mul(0.14));
  const whitecap = smoothstep(
    oneMinus(cover).sub(edge).sub(soft),
    oneMinus(cover).add(edge).add(soft),
    pattern,
  )
    .mul(smoothstep(float(0), float(0.5), cover))
    .clamp(0, 1);

  // The wake, computed rather than drawn: the surface knows its own world position, so it can be
  // told where a hull is and work out whether it is standing in its wake. Everything is in the
  // hull's frame, so the wedge is a comparison rather than a rotation.
  const toShip = vec2(positionWorld.x.sub(shipOrigin.x), positionWorld.z.sub(shipOrigin.y));
  const starboard = vec2(shipForward.y.negate(), shipForward.x);
  const astern = dot(toShip, shipForward).negate();
  const across = abs(dot(toShip, starboard));
  const halfWidth = astern.mul(WAKE.spread).add(WAKE.waist);
  const churn = smoothstep(halfWidth.mul(0.62), halfWidth.mul(0.12), across).mul(0.6);
  const arms = smoothstep(halfWidth.mul(0.5), float(0), abs(across.sub(halfWidth)));
  const reach = smoothstep(float(WAKE.length), float(0), astern);
  const begins = smoothstep(float(-1.4), float(1.6), astern);
  const tear = smoothstep(float(0.35), float(0.7), pattern);
  const wake = max(churn, arms).mul(reach).mul(begins).mul(wakeStrength).mul(tear).mul(0.78);
  const plan = vec2(astern.div(HULL_WASH.halfLength), across.div(HULL_WASH.halfBeam));
  const wash = smoothstep(float(1.34), float(0.94), plan.length()).mul(
    smoothstep(float(0.62), float(0.94), plan.length()),
  );
  const bow = smoothstep(float(-1.4), float(-2.5), astern)
    .mul(smoothstep(float(-5), float(-3.5), astern))
    .mul(smoothstep(float(1.3), float(0.2), across))
    .mul(wakeStrength)
    .mul(tear);
  const broken = max(max(wake, bow), wash.mul(tear).mul(wakeStrength));
  const foamMask = max(whitecap, broken);

  // Colour by height, deep in the troughs and lit on the shoulders. These bands are metres of wave
  // height, so they move with `waveHeight`.
  const height = positionWorld.y;
  const reference = float(state.waveHeight ?? 1);
  const shade = smoothstep(reference.mul(-0.45), reference.mul(0.4), height);
  const water = mix(color(LOOK.deep), color(LOOK.shallow), shade);
  const toEye = eye.normalize();
  const fresnelOf = (normal: Node<"vec3">) =>
    pow(oneMinus(saturate(dot(normal, toEye))), float(5))
      .mul(0.97963)
      .add(0.02037);
  // Light that enters the water is light the surface did not reflect: the body is lit by what
  // Fresnel leaves, so at a grazing view the sea is its reflection, not its colour. Taken from a
  // partly smoothed normal, because the ripples finer than a pixel still face the eye.
  const transmitted = oneMinus(fresnelOf(mix(normalWorld, vec3(0, 1, 0), 0.45).normalize()));
  material.colorNode = cheap
    ? water
    : mix(water.mul(transmitted), color(LOOK.foam), foamMask.mul(0.95));

  if (!cheap) {
    // Light coming through a thin backlit crest: it needs a face turned away from the sun, a
    // height near the surface and the eye looking nearly into the sun, and it fades with distance.
    const crest = saturate(height.sub(reference.mul(0.05)).div(reference.mul(0.8)));
    const toSun = pow(max(dot(sunDirection, toEye.negate()), 0), float(4));
    const thin = pow(saturate(dot(sunDirection, normalWorld).mul(-0.5).add(0.5)), float(3));
    const glow = crest
      .mul(crest)
      .mul(toSun)
      .mul(thin)
      .mul(distance.div(-600).exp())
      .mul(LOOK.subsurfaceGain);
    const tint = new Color(LOOK.subsurface);
    const subsurface = vec3(tint.r, tint.g, tint.b)
      .mul(sunRadiance)
      .mul(glow)
      .mul(oneMinus(foamMask));

    // The hull, the marks and the headland, in the water, sharp: the one thing a prefiltered
    // environment cannot do. Fresnel decides how much, as it does for the sky.
    const fresnel = fresnelOf(normalWorld);
    material.emissiveNode =
      mirror === undefined
        ? subsurface
        : subsurface.add(
            mirror
              .reflectionAt(normalWorld.xz.mul(0.02))
              .mul(LOOK.mirrorGain)
              .mul(fresnel)
              .mul(oneMinus(foamMask.mul(0.75))),
          );
  }

  // Roughness is spent, not lost: the unresolved slope reappears here, and broken water is not a
  // mirror either.
  if (!cheap) {
    const { near, far, from, to } = LOOK.capillarySlope;
    const capillary = smoothstep(float(from), float(to), distance).mul(far).add(near);
    const filtered = unresolved.max(0).add(capillary).sqrt().sqrt();
    material.roughnessNode = max(filtered, foamMask.mul(0.9));
  }

  // The sun's glint, the sky's mirror image and the foam's light are the sea's own; see the model.
  material.setupLightingModel = () => new SeaLightingModel(foamMask);

  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "realistic-sea-surface";

  return {
    mesh,
    advance(elapsed: number): void {
      seaTime.value = elapsed;
      maps.advance(elapsed);
    },
    wake(x: number, z: number, forwardX: number, forwardZ: number, strength: number): void {
      shipOrigin.value.set(x, z);
      shipForward.value.set(forwardX, forwardZ);
      wakeStrength.value = Math.max(0, Math.min(1, strength));
    },
    // Snapped to whole metres: following continuously would slide every vertex through the wave
    // field by a fraction of its size each frame and the surface would crawl.
    follow(x: number, z: number): void {
      const snappedX = Math.round(x);
      const snappedZ = Math.round(z);
      mesh.position.set(snappedX, 0, snappedZ);
      seaOrigin.value.set(snappedX, snappedZ);
    },
    setSun(direction, radiance): void {
      const length = Math.hypot(direction[0], direction[1], direction[2]);
      if (!(length > 0) || !Number.isFinite(length))
        throw new Error("Realistic ocean sun direction must be a finite, non-zero vector.");
      sunDirection.value.set(direction[0] / length, direction[1] / length, direction[2] / length);
      if (radiance !== undefined) sunRadiance.value.set(...radiance);
    },
    reset(): void {
      maps.reset();
    },
    dispose(): void {
      mirror?.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
