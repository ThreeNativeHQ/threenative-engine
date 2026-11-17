/** Game-owned air; the installed Atmosphere owns LUT compute and lifetime. */
import { Atmosphere } from "@threenative/core";
import { BackSide } from "three";
import {
  cameraPosition,
  color,
  dot,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  output,
  positionLocal,
  positionWorld,
  pow,
  select,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";
import type { IBiome } from "../biomes.js";
import { LOOK } from "../lookKnobs.js";

export function createAtmosphere(look: IBiome): Atmosphere {
  const air = new Atmosphere({
    rayleigh: look.atmosphere.rayleigh,
    mie: [look.atmosphere.mie, look.atmosphere.mie, look.atmosphere.mie],
    ozone: [0.00065, 0.001881, 0.000085],
    planetRadius: 6360,
    atmosphereRadius: 6460,
  });
  air.name = "world-atmosphere";
  return air;
}

/** Same spectral extinction and solar phase on the dome and the distant landscape. */
export function skyRadiance(
  air: Atmosphere,
  direction: Node<"vec3">,
  sun: Node<"vec3">,
  look: IBiome,
): Node<"vec3"> {
  const mu = dot(direction, sun).clamp(-1, 1);
  const elevation = direction.y.max(0.035);
  const transmission = air.sunTransmittance(
    vec3(0, elevation, float(1).sub(elevation.mul(elevation)).max(0).sqrt()),
  ) as Node<"vec3">;
  // Absorption removes light; only the scattering share can become sky radiance.
  const parameters = air.parameters;
  const rayleighColumn = vec3(parameters.rayleigh).mul(8);
  const scatteringShare = rayleighColumn.div(
    rayleighColumn.add(vec3(parameters.mie).mul(1.2)).add(vec3(parameters.ozone).mul(15)),
  );
  const rayleighPhase = mu.mul(mu).add(1).mul(0.75);
  const g = look.sky.mieDirectionalG;
  const miePhase = float(1 - g * g).div(
    float(1 + g * g)
      .sub(mu.mul(2 * g))
      .max(0.001)
      .pow(1.5),
  );
  // The LUT's angular coordinate follows the sun, rather than a fixed world X axis.
  const multiple = air.luts.sampleSkyView(
    vec2(mu.mul(0.5).add(0.5), direction.y.mul(0.5).add(0.5)),
  ).rgb;
  const sunlight = (air.sunTransmittance(sun) as Node<"vec3">).mul(color(look.sun.color));
  return transmission
    .oneMinus()
    .mul(scatteringShare)
    .mul(rayleighPhase)
    .mul(look.atmosphere.radiance)
    .add(multiple.mul(look.atmosphere.radiance * 0.25))
    .add(sunlight.mul(miePhase).mul(look.atmosphere.mie * 4));
}

export function skyColour(air: Atmosphere, sun: Node<"vec3">, look: IBiome): Node<"vec3"> {
  const direction = normalize(positionLocal);
  const mu = dot(direction, sun);
  const disc = smoothstep(Math.cos(0.006), Math.cos(0.00465), mu);
  return skyRadiance(air, direction, sun, look).add(
    (air.sunTransmittance(sun) as Node<"vec3">).mul(color(look.sun.color)).mul(disc).mul(48),
  );
}

/** Depth-reconstructed world position applies one air composite to the complete lit scene. */
export function aerialPerspective(
  air: Atmosphere,
  sun: Node<"vec3">,
  look: IBiome,
  enabled = true,
  surface: Node<"vec3"> = positionWorld,
  eye: Node<"vec3"> = cameraPosition,
  input: Node<"vec4"> = output,
): Node<"vec4"> {
  const ray = surface.sub(eye);
  const direction = normalize(ray);
  const height = look.haze.height;
  const low = eye.y.min(surface.y).max(0);
  const span = ray.y.abs().div(height);
  // Analytic mean density along the ray; the limit at equal heights is one.
  const column = span.negate().exp().oneMinus().div(span.max(0.001));
  // Mean density along the ray relative to its low end, as UE's exponential height fog integrates
  // it: a ridge 800 m above the valley sits above most of the haze and stays readable.
  const climb = mix(1, column, smoothstep(0.001, 0.01, span));
  const density = low.div(-height).exp().mul(climb);
  // Clear foreground; aerosol weather builds on landscape distances, not prop distances.
  const distanceKm = ray.length().sub(150).max(0).div(1000);
  // The playable valley keeps its clear air; the alpine fog and the deeper blue build past `reach`.
  const fog = look.atmosphere.heightFog;
  const reach = fog ? smoothstep(fog.reach[0], fog.reach[1], ray.length()) : float(0);
  const opticalDistance = distanceKm.mul(
    density
      .mul(0.65)
      .add(0.35)
      .mul(
        fog
          ? mix(look.atmosphere.distanceScale, fog.distanceScale, reach)
          : look.atmosphere.distanceScale,
      ),
  );
  const zenith = air.sunTransmittance(vec3(0, 1, 0)) as Node<"vec3">;
  // ponytail: the decorative continuation ends at 2.3 km; extend it before increasing this weather cutoff.
  const boundary = smoothstep(
    look.atmosphere.horizonFade[0],
    look.atmosphere.horizonFade[1],
    ray.length(),
  );
  const transmission = enabled
    ? zenith.max(0.0001).pow(opticalDistance.div(8)).mul(boundary.oneMinus())
    : vec3(1);
  const scattering = skyRadiance(air, direction, sun, look);
  // Local aerosol tint preserves soil-coloured shadows; the remote column is the LUT sky.
  const valleyHaze = ray
    .length()
    .mul(look.haze.density)
    .mul(climb)
    .pow(2)
    .negate()
    .exp()
    .oneMinus()
    .mul(smoothstep(150, 250, ray.length()));
  const localAmount = !enabled
    ? float(0)
    : fog
      ? mix(valleyHaze, heightFogAmount(fog, eye, direction, ray.length(), surface.y), reach)
      : valleyHaze;
  const localTint = mix(
    color(look.haze.color),
    color(look.sun.color).mul(1.4),
    dot(direction, sun).max(0).pow(6).mul(look.haze.sunScatter),
  );
  let localColour: Node<"vec3"> = mix(input.rgb, localTint, localAmount);
  const mist = look.atmosphere.groundMist;
  if (mist && enabled) {
    // The density, thickness, ceiling and colour are `LOOK` uniforms, so a tweak box moves them live.
    const term = {
      density: LOOK.mistDensity as unknown as number,
      height: mist.term.height,
      scale: LOOK.mistScale as unknown as number,
    };
    const amount = heightFogAmount(
      { reach: [0, 0], distanceScale: 1, start: mist.start, terms: [term] },
      eye,
      direction,
      ray.length(),
      surface.y,
    ).min(LOOK.mistOpacity);
    // Toward the low sun the mist carries its light; away from it, the shade's cool air.
    const lit = dot(direction, sun)
      .max(0)
      .pow(4)
      .mul(look.haze.sunScatter * 2)
      .min(1);
    localColour = mix(
      localColour,
      mix(LOOK.mistColor, color(look.sun.color).mul(1.2), lit),
      amount,
    );
  }
  return vec4(localColour.mul(transmission).add(scattering.mul(transmission.oneMinus())), input.a);
}

/**
 * Opacity of the height fog between the eye and a surface, with UE's analytic line integral of an
 * exponential density along the ray (UE 5.8.3: Engine/Shaders/Private/HeightFogCommon.ush:207-214,
 * start distance :288-305). Linear in distance, unlike the distance-squared haze: a 10% farther
 * gully is about 10% more hazed, not twice, so spur and gully keep their own shading.
 */
function heightFogAmount(
  fog: NonNullable<IBiome["atmosphere"]["heightFog"]>,
  eye: Node<"vec3">,
  direction: Node<"vec3">,
  length: Node<"float">,
  surfaceY: Node<"float">,
): Node<"float"> {
  const travelled = length.sub(fog.start).max(0);
  const startY = eye.y.add(direction.y.mul(length.min(fog.start)));
  const rise = surfaceY.sub(startY);
  let depth: Node<"float"> = float(0);
  for (const term of fog.terms) {
    const x = rise.div(term.scale).clamp(-60, 60);
    // (1 - e^-x) / x, with its Taylor limit where the ray runs level.
    const shape = select(
      x.abs().lessThan(0.001),
      float(1).sub(x.mul(0.5)),
      x.negate().exp().oneMinus().div(x),
    );
    // `div` then `negate`, not `div(-scale)`: the mist's scale is a uniform node, and `-node` is NaN.
    const atStart = startY
      .sub(term.height)
      .div(term.scale)
      .negate()
      .min(60)
      .exp()
      .mul(term.density);
    depth = depth.add(atStart.mul(shape).mul(travelled));
  }
  return depth.negate().exp().oneMinus();
}

/** The cumulus deck. Every number is this game's weather. */
const CLOUDS = {
  /** Noise cells across the whole sky. Fewer is a bigger, calmer deck. */
  scale: 1.5,
  /**
   * Vertical stretch of the field, and it is a stretch and not a squash for the reason it looks like
   * one: the field is sampled in view *direction*, so multiplying y up by three makes each cell
   * three times wider than it is tall, which is what a cumulus deck seen from underneath is —
   * puffs with flat bases. Squash it and every cell becomes a column, and the sky fills with smoke.
   */
  stretch: 2.2,
  /**
   * Where the bank field runs from bare sky to solid deck, and where the puff field runs from
   * nothing to solid on top of it. Both ramps are narrow on purpose: a wide one is a smear, and a
   * smear across the whole sky is a fog bank, not a cumulus.
   */
  bank: [-0.2, 0.22],
  coverage: [0.02, 0.42],
  /** The band of sky the deck occupies: its base just above the horizon, thinning towards the zenith. */
  band: [0.02, 0.1, 0.99, 0.5],
  /** Sunlit crown, shaded underside, and the silver a thin fringe takes when it faces the sun. */
  tint: { lit: 0xf7f8f9, shade: 0xc8d3de, silver: 0xfff2d4 },
  /** How much a dense core is darkened relative to a thin fringe. */
  core: 0.55,
  /** Up share of a puff's side normal: lower is a lumpier, more sculpted body. */
  relief: 1.2,
  /**
   * The deck's brightness against the physical sky behind it. The sky is in radiance units several
   * times above one, so a cloud written as plain white came out darker than the blue around it —
   * grey blobs — once the rig stopped fogging its own dome.
   */
  radiance: 1.65,
} as const;

/**
 * The cloud deck: a dome inside the rig's sky box, alpha-blended over the physical sky.
 *
 * Lit by one dot product against the sun rather than by a volume integral, because a volume is a
 * compute pass per frame and this is a fragment shader over the sky's own pixels. What sells it is
 * the shading, not the integration: sun side white, away side blue-grey, a silver lining where the
 * coverage is thin and the sun is behind, and every core darkened — which is the same read a
 * volumetric integral gives at this size, for one noise field and one `dot`.
 */
export function cloudDome(air: Atmosphere, sun: Node<"vec3">, look: IBiome): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    // Seen from the inside, and never written to depth: the deck is behind everything else in the
    // world and must not occlude a single blade of grass in front of it.
    depthWrite: false,
    fog: false,
    side: BackSide,
    transparent: true,
  });
  // The only coordinate a sky has is the direction to the fragment.
  const direction = normalize(positionLocal);
  // Ray intersection with a cloud layer: distant cells shrink towards the horizon.
  const field = vec3(direction.x, direction.y.mul(CLOUDS.stretch), direction.z)
    .div(direction.y.max(0.08))
    .mul(CLOUDS.scale);
  const puff = mx_fractal_noise_float(field, 4, 2, 0.5);
  const bank = mx_fractal_noise_float(field.mul(0.3), 2, 2, 0.5);
  // Density sampled towards the live sun approximates self-shadow inside each soft puff.
  const lightDepth = mx_fractal_noise_float(field.add(sun.mul(0.55)), 3, 2, 0.5);
  const crown = smoothstep(-0.12, 0.24, puff.sub(lightDepth.mul(0.65)));
  const coverage = smoothstep(float(CLOUDS.coverage[0]), float(CLOUDS.coverage[1]), puff);
  const deck = smoothstep(float(CLOUDS.band[0]), float(CLOUDS.band[1]), direction.y).mul(
    smoothstep(float(CLOUDS.band[2]), float(CLOUDS.band[3]), direction.y),
  );
  const toSun = max(dot(direction, sun), 0);
  const sunlight = (air.sunTransmittance(sun) as Node<"vec3">).mul(color(look.sun.color));
  const shade = skyRadiance(air, normalize(vec3(direction.x, 0.7, direction.z)), sun, look)
    .mul(0.4)
    .add(color(CLOUDS.tint.shade).mul(0.35));
  // Each puff as a lit body: the field's gradient is the outward normal of its side (the field's
  // x and z are the world's), so the side that faces the sun is bright and the far side and the
  // thick base fall into shade, the read a volume integral gives a cumulus at this size.
  const step = 0.03;
  const outward = normalize(
    vec3(
      puff.sub(mx_fractal_noise_float(field.add(vec3(step, 0, 0)), 4, 2, 0.5)).div(step),
      float(CLOUDS.relief),
      puff.sub(mx_fractal_noise_float(field.add(vec3(0, 0, step)), 4, 2, 0.5)).div(step),
    ),
  );
  const sunSide = smoothstep(-0.25, 0.55, dot(outward, sun));
  const lit = mix(
    shade,
    sunlight.mul(color(CLOUDS.tint.lit)),
    sunSide.mul(crown.mul(0.5).add(0.5)).max(smoothstep(float(0.2), float(0.7), toSun)),
  );
  // The lining: thin coverage facing the sun, and only there.
  const fringe = color(CLOUDS.tint.silver)
    .mul(pow(toSun, float(8)))
    .mul(float(1).sub(coverage))
    .mul(float(0.55))
    .mul(sunlight);
  material.colorNode = lit
    .add(fringe)
    .mul(mix(float(1), float(CLOUDS.core), coverage))
    .mul(CLOUDS.radiance);
  // Optical thickness leaves translucent wisps instead of a hard clipped noise contour.
  const density = coverage
    .mul(smoothstep(float(CLOUDS.bank[0]), float(CLOUDS.bank[1]), bank))
    .mul(deck);
  material.opacityNode = float(1).sub(density.mul(-2.4).exp()).mul(look.clouds);
  return material;
}
