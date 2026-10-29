// The coastal kit's sea: the installed spectral simulation drives a lit water surface. It is the example
// game's ocean, ported so the kit draws what the simulation computes: a game-owned ocean source, the
// installed SpectralOcean, and a lit water mesh. The vertex stage reads the simulation's cascade buffers, so
// what is drawn is the field the height query reads. The installed shore-wave bake turns the world's
// bathymetry into where a swell arrives and how tall it stands, and that field decides the surf and the depth
// tint. Change `SEA`, `SHORE`, `SURFACE` or `OCEAN_LOOK` to change the sea; nothing in a package decides it.
import type { ICtx, ISpectralOceanOptions } from "@threenative/core";
import { SpectralOcean, bakeShoreWaves } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
} from "three";
import {
  cameraPosition,
  clamp,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** The sea state: two non-overlapping wave bands, as the example game uses. */
export const SEA = {
  amplitude: 0.0018,
  cascades: [{ patchSize: 190 }, { patchSize: 37 }],
  choppiness: 1.2,
  directionality: 2.6,
  gravity: 9.81,
  readbackEveryFrames: 3,
  readbackResolution: 32,
  resolution: 128,
  seed: 20_260_906,
  smallWaveCutoff: 0.32,
  windDirection: 0.55,
  windSpeed: 10.5,
} satisfies ISpectralOceanOptions;

/** Dense inner grid; its outer vertices stretch to the distant horizon. */
export const SURFACE = { segments: 512, size: 1024 } as const;

/** The sea's two body colours as live uniforms, so the game can retint the water without rebuilding it. */
export const OCEAN_LOOK = {
  deep: uniform(new Color(0x082e45)),
  shallow: uniform(new Color(0x24646a)),
};

/** Thin breaking surf on exposed shores. */
const FOAM = 0xe9f4f6;

/**
 * The swell that breaks on this shore. `incidentHeight` is the crest height the bake shoals and caps:
 * the one number the bathymetry cannot measure for itself. Everything else here is a look.
 */
export const SHORE = {
  incidentHeight: 1.15,
  /** The main train's deep-water wavelength, in metres. Sets its period: omega = sqrt(g 2pi / lambda). */
  wavelength: 46,
  /** The fronts' speed, as a multiple of the shallow-water celerity the bake measured. */
  speed: 1,
  /**
   * The horizontal compression a crest's Gerstner push and its plunging lean may use between them.
   * A heightfield cannot overhang, so both come out of one budget and the surface never folds.
   */
  steepness: 0.85,
  /**
   * The depth, in metres, at which the simulated swell is fully replaced by the breakers, on Unreal's
   * own curve (`1 - exp(-depth / (swellFadeDepth / 2))`): UE 5.8.3 WaterBodyComponent.cpp:113 and
   * GerstnerWaveFunctions.ush:429. Unreal's default is `TargetWaveMaskDepth` = 20.48 m, for a 20 m
   * ocean; left undefined here, this sea states its own and measures it: the deepest water in the
   * bake, so a four-metre shelf keeps its swell instead of fading it out over dry sand.
   */
  swellFadeDepth: undefined as number | undefined,
  /**
   * How fast the drawn sea floor falls away offshore, in metres per metre. A heightmap has no
   * bathymetry past its flat shelf, so this is the look's own: it sets how wide the shallow tint
   * runs before the open sea's colour, and where the breakers hand over to the swell.
   */
  shelfSlope: 0.08,
} as const;

/**
 * What the surface reads from the bake: the heights on the world's grid, row-major by Z then X, in metres,
 * with the sea level and the world's size.
 */
export interface ICoastalSeaData {
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly size: number;
  readonly waterLevel: number;
}

/** The sea in the scene. `dispose` removes the surface, releases the simulation and the surface's textures. */
export interface ICoastalSea {
  readonly mesh: Mesh;
  readonly ocean: SpectralOcean;
  dispose(): void;
}

/** Bilinear periodic sampling; wrap twice because JavaScript/WGSL remainder can be negative. */
function cascadeAt(
  ocean: SpectralOcean,
  index: number,
  x: Node<"float">,
  z: Node<"float">,
): Node<"vec4"> {
  const grid = float(ocean.resolution);
  const patch = float(ocean.cascadePatchSize(index));
  const buffer = ocean.cascadeDisplacement(index);
  const u = x.div(patch).mul(grid);
  const v = z.div(patch).mul(grid);
  const u0 = u.floor();
  const v0 = v.floor();
  const wrap = (value: Node<"float">): Node<"float"> => value.mod(grid).add(grid).mod(grid);
  const read = (cx: Node<"float">, cz: Node<"float">): Node<"vec4"> =>
    buffer.element(wrap(cz).mul(grid).add(wrap(cx)).toUint()) as Node<"vec4">;
  const near = mix(read(u0, v0), read(u0.add(1), v0), u.sub(u0));
  const far = mix(read(u0, v0.add(1)), read(u0.add(1), v0.add(1)), u.sub(u0));
  return mix(near, far, v.sub(v0)) as Node<"vec4">;
}

/** Summed displacement of both cascades at a world position. */
function displacementAt(ocean: SpectralOcean, x: Node<"float">, z: Node<"float">): Node<"vec3"> {
  const broad = cascadeAt(ocean, 0, x, z);
  const fine = cascadeAt(ocean, 1, x, z);
  return vec3(broad.x.add(fine.x), broad.y.add(fine.y), broad.z.add(fine.z));
}

/**
 * The sea surface: displaced by the simulation, and lit by the scene. The vertex stage reads the cascade
 * buffers directly, so what is drawn is the same field the height query is copied from.
 */
function createSeaMesh(ocean: SpectralOcean, data: ICoastalSeaData): Mesh {
  const level = data.waterLevel;
  if (!Number.isFinite(level)) throw new Error("Coastal bake has no finite sea level");
  // Where the swell arrives, how fast and how tall, measured from the bathymetry the bake already has.
  // The front fields replace the hand-rolled distance-to-land and exposure flood fill this kit used to
  // carry: a cell no front reaches (a lagoon behind a bar) has a fade of zero and draws no surf.
  const waves = bakeShoreWaves(data.heights, data.resolution, data.size, level, SHORE);
  const n = data.resolution;
  // Two textures: a front carries more than four numbers, and the ground's own height and the wave
  // travel time are read in both stages.
  //   ground: height, travel time, how clean the front is, Green's law shoaling
  //   fronts: front direction x and z, the crest the bake allows, unused
  const groundPixels = new Uint16Array(n * n * 4);
  const frontPixels = new Uint16Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const travel = waves.travel[i] as number;
    const reached = Number.isFinite(travel);
    groundPixels[i * 4] = DataUtils.toHalfFloat(data.heights[i] as number);
    // No front to time: the phase there is masked by the same cell's fade, so the value is not read.
    groundPixels[i * 4 + 1] = DataUtils.toHalfFloat(reached ? Math.min(travel, 600) : 0);
    groundPixels[i * 4 + 2] = DataUtils.toHalfFloat(waves.fade[i] as number);
    groundPixels[i * 4 + 3] = DataUtils.toHalfFloat(waves.shoaling[i] as number);
    frontPixels[i * 4] = DataUtils.toHalfFloat(waves.directionX[i] as number);
    frontPixels[i * 4 + 1] = DataUtils.toHalfFloat(waves.directionZ[i] as number);
    frontPixels[i * 4 + 2] = DataUtils.toHalfFloat(waves.height[i] as number);
  }
  const textureOf = (pixels: Uint16Array): DataTexture => {
    const texture = new DataTexture(pixels, n, n, RGBAFormat, HalfFloatType);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;
    return texture;
  };
  const heightTexture = textureOf(groundPixels);
  const frontTexture = textureOf(frontPixels);
  const geometry = new PlaneGeometry(
    SURFACE.size,
    SURFACE.size,
    SURFACE.segments,
    SURFACE.segments,
  );
  geometry.rotateX(-Math.PI / 2);
  // Dense near shore, sparse beyond it; the sea reaches the fogged horizon instead of ending at the world's edge.
  const vertices = geometry.getAttribute("position");
  const stretch = (value: number): number =>
    Math.sign(value) *
    (Math.abs(value) <= 320 ? Math.abs(value) : 320 + ((Math.abs(value) - 320) / 192) ** 2 * 3800);
  for (let i = 0; i < vertices.count; i++)
    vertices.setXYZ(i, stretch(vertices.getX(i)), 0, stretch(vertices.getZ(i)));
  geometry.computeBoundingSphere();

  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    transparent: true,
    depthWrite: true,
    roughness: 0.12,
  });
  const shoreUV = (x: Node<"float">, z: Node<"float">) =>
    vec2(x.div(data.size).add(0.5), z.div(data.size).add(0.5));
  const inside = (x: Node<"float">, z: Node<"float">) =>
    float(1).sub(smoothstep(data.size / 2 - 2, data.size / 2 + 2, x.abs().max(z.abs())));
  const seaLevel = float(level);
  const gravity = float(SEA.gravity);
  // Which way this coast's swell comes in: the crest-weighted mean of the fronts the bake measured, so
  // the game states no bearing and a coast that turns away from its own swell gets the small sets.
  let swellX = 0;
  let swellZ = 0;
  for (let i = 0; i < waves.height.length; i++) {
    const crest = waves.height[i] as number;
    swellX += crest * (waves.directionX[i] as number);
    swellZ += crest * (waves.directionZ[i] as number);
  }
  const swellLength = Math.hypot(swellX, swellZ) || 1;
  const swell = vec2(swellX / swellLength, swellZ / swellLength);
  // Unreal's depth fade, at the depth this sea states: the modelled swell fades out where the
  // breakers take over. Land is dry, and the curve is only ever a fade, so a negative depth is clamped.
  const deepest = data.heights.reduce((deepest, height) => Math.max(deepest, level - height), 0);
  const swellFadeDepth = SHORE.swellFadeDepth ?? Math.max(2, deepest);
  const shallower = (depth: Node<"float">): Node<"float"> =>
    float(1).sub(
      depth
        .max(0)
        .div(swellFadeDepth / 2)
        .negate()
        .exp(),
    );
  // The bake ends where the world does. Fading the breakers over the last forty metres keeps that
  // edge from reading as a raised wall standing in the water.
  const edge = (x: Node<"float">, z: Node<"float">): Node<"float"> =>
    float(1).sub(smoothstep(data.size / 2 - 40, data.size / 2 - 2, x.abs().max(z.abs())));
  // A heightmap holds no bathymetry, so its sea floor is a flat shelf out to the world's edge, and a
  // tint read from it alone ends in a square where the open sea begins. The floor drawn here falls away
  // from the coast at `SHORE.shelfSlope`, offshore distance measured by the bake's travel time (exact
  // on the flat shelf), and keeps falling past the bake's edge, so the shelf ends along the coastline.
  const shelfCelerity = Math.sqrt(SEA.gravity * Math.max(deepest, 0.25));
  const floorDepth = (
    x: Node<"float">,
    z: Node<"float">,
    surface: Node<"float">,
    offshore = true,
  ): Node<"float"> => {
    const ground = texture(heightTexture, shoreUV(x, z));
    const beyond = x
      .abs()
      .max(z.abs())
      .sub(data.size / 2)
      .max(0);
    // Past the edge the ground the bake clamps to is the rim; dry rim still has sea beyond it.
    const here = surface.sub(ground.r);
    const rim = mix(here, here.max(0), smoothstep(0, 1, beyond));
    const away = offshore ? ground.g.mul(shelfCelerity).add(beyond) : beyond;
    return rim.add(away.mul(SHORE.shelfSlope));
  };

  /**
   * The breakers at a world point, read from the bake's front fields. One front, two trains on it: the
   * long one carries the set and the short one the chop on its face. Their phases are omega (tau + t),
   * so a front slows, bunches and refracts exactly where the bathymetry says it must, and both the
   * crest's Gerstner push and its plunging lean come out of one compression budget, so the surface
   * never folds over itself. Returns the vertical displacement, the horizontal push and the crest foam.
   */
  const breakers = (x: Node<"float">, z: Node<"float">) => {
    const ground = texture(heightTexture, shoreUV(x, z));
    const front = texture(frontTexture, shoreUV(x, z));
    const local = edge(x, z);
    const depth = seaLevel.sub(ground.r).max(0.02);
    const travel = ground.g.add(time.mul(SHORE.speed));
    const steer = vec2(front.r, front.g);
    // A coast that faces the swell gets the sets; a lee shore only the lee's small ones. A shock in the
    // travel time, where two stretches of coast agree on neither, fades the whole train out.
    const exposure = mix(float(0.2), float(1), smoothstep(-0.4, 0.6, steer.dot(swell)));
    const group = mx_noise_float(vec3(x.mul(0.006), z.mul(0.006), time.mul(0.02)))
      .mul(0.4)
      .add(0.7);
    const offset = mx_noise_float(vec3(x.mul(0.0042), z.mul(0.0042), 0)).mul(5);
    // A front feels the floor from about a quarter wavelength in; past that the simulated swell is the
    // sea, so the breakers hand over offshore instead of marching on to the bake's edge.
    const feelsFloor = float(1).sub(
      smoothstep(SHORE.wavelength / 8, SHORE.wavelength / 4, floorDepth(x, z, seaLevel)),
    );
    const crest = front.b.mul(ground.b).mul(local).mul(feelsFloor).mul(exposure).mul(group);
    // The celerity the crest's *shape* uses is floored at a depth the mesh can draw: a swarm of
    // two-metre crests on a two-metre mesh is a scalloped smear, not a wave. The bake's own physics
    // still decides where a front reaches and how tall it stands; only the shape is band-limited.
    const celerity = depth.clamp(1.5, 14).mul(gravity).sqrt();
    let height: Node<"float"> = float(0);
    let push: Node<"vec2"> = vec2(0, 0);
    let slope: Node<"vec2"> = vec2(0, 0);
    let foam: Node<"float"> = float(0);
    // The budget the lean and the push share, and it is spent by the trains in order.
    let pinch: Node<"float"> = float(SHORE.steepness);
    for (const [index, train] of [
      { amplitude: crest, wavelength: SHORE.wavelength, phase: float(0) },
      { amplitude: crest.mul(0.45), wavelength: SHORE.wavelength * 0.61, phase: float(2.1) },
    ].entries()) {
      const omega = float(Math.sqrt((SEA.gravity * 2 * Math.PI) / train.wavelength));
      const phase = omega
        .mul(travel)
        .add(train.phase)
        .add(offset.mul(index === 0 ? 1 : 1.37));
      const waveNumber = omega.div(celerity);
      const c = phase.cos().mul(0.5).add(0.5);
      const s = phase.sin();
      const shaped = c.pow(0.6);
      const c5 = c.pow(5);
      const relative = train.amplitude.div(depth);
      // Sections of each crest break early or late, and the layout changes wave by wave: the crest peels
      // along the shore instead of breaking all at once.
      const cycle = phase
        .add(Math.PI)
        .div(2 * Math.PI)
        .floor();
      const early = mx_noise_float(
        vec3(x.mul(0.09).add(cycle.mul(7.3)), z.mul(0.09).add(cycle.mul(3.1)), float(index)),
      )
        .mul(0.5)
        .add(0.5);
      const breaking = smoothstep(early.mul(0.14).add(0.12), early.mul(0.2).add(0.3), relative);
      // Only the main train plunges, and only around its break point; inside it the wave runs as a bore.
      const lean =
        index === 0
          ? train.amplitude
              .mul(2 * SHORE.steepness)
              .mul(smoothstep(0.16, 0.28, relative))
              .mul(float(1).sub(smoothstep(0.4, 0.6, relative)))
          : float(0);
      const leanNow = lean.min(float(0.35).div(waveNumber.mul(1.08)));
      pinch = pinch.sub(leanNow.mul(waveNumber).mul(1.08));
      const pushed = pinch.min(train.amplitude.mul(waveNumber).mul(SHORE.steepness * 8));
      pinch = pinch.sub(pushed);
      height = height.add(train.amplitude.mul(shaped.mul(c).mul(2).sub(0.78)));
      push = push.add(steer.mul(pushed.div(waveNumber).mul(s).add(leanNow.mul(c5).mul(c))));
      slope = slope.add(
        steer.mul(
          train.amplitude
            .mul(waveNumber)
            .mul(1.6)
            .mul(shaped)
            .mul(s)
            .div(
              float(1)
                .sub(pushed.mul(phase.cos()))
                .add(leanNow.mul(waveNumber).mul(c5).mul(s).mul(3))
                .max(0.2),
            ),
        ),
      );
      // White water on the crest and trailing behind it once the wave is near breaking, broken up
      // across the face so a crest reads as spray and lace rather than a painted ribbon.
      const behind = phase
        .add(Math.PI)
        .mod(2 * Math.PI)
        .sub(Math.PI);
      const lace = smoothstep(
        -0.35,
        0.45,
        mx_noise_float(
          vec3(x.mul(0.42).add(behind.mul(2.4)), z.mul(0.42), time.mul(0.35).add(float(index))),
        ),
      );
      foam = foam.add(
        breaking
          .mul(smoothstep(-0.2, 0, behind))
          .mul(behind.max(0).mul(-1.8).exp())
          .mul(lace.mul(0.8).add(0.2))
          .mul(index === 0 ? 1 : 0.35),
      );
    }
    return { crest, depth, foam: foam.max(0), height, push, slope };
  };

  // The crest pattern belongs to the still-water point, not to where the wave has pushed it: sampling
  // it at the displaced position double-exposes the foam and smears the face. One varying, both stages.
  const shorePoint = varying(positionLocal.xz, "vShorePoint");
  const vertexFront = breakers(shorePoint.x, shorePoint.y);
  // The swell fades on the bathymetry itself, so a trough never dips below a sandbar; only past the
  // bake's edge, where there is none, does it read the drawn floor.
  const vertexDepth = floorDepth(positionLocal.x, positionLocal.z, seaLevel, false);
  const vertexDistance = positionLocal.xz.sub(cameraPosition.xz).length();
  const swellFade = float(1).sub(smoothstep(240, 1600, vertexDistance));
  material.positionNode = positionLocal.add(
    displacementAt(ocean, positionLocal.x, positionLocal.z)
      .mul(shallower(vertexDepth))
      .mul(swellFade)
      .add(vec3(vertexFront.push.x, vertexFront.height, vertexFront.push.y)),
  );

  const eyeDistance = positionWorld.sub(cameraPosition).length();
  const slopeFade = float(1).sub(smoothstep(100, 950, eyeDistance));
  const step = float(0.45).add(eyeDistance.mul(0.006));
  const east = displacementAt(ocean, positionWorld.x.add(step), positionWorld.z);
  const west = displacementAt(ocean, positionWorld.x.sub(step), positionWorld.z);
  const north = displacementAt(ocean, positionWorld.x, positionWorld.z.add(step));
  const south = displacementAt(ocean, positionWorld.x, positionWorld.z.sub(step));
  // Small ripples have no directional period, so they do not read as corduroy.
  const ripplePoint = vec3(
    positionWorld.x.mul(0.85).sub(time.mul(0.22)),
    positionWorld.z.mul(0.85).add(time.mul(0.11)),
    time.mul(0.07),
  );
  const rippleHeight = (point: Node<"vec3">) =>
    mx_fractal_noise_float(point, 3, 2.1, 0.48).mul(0.028);
  const h = rippleHeight(ripplePoint);
  const ripple = vec3(
    h.sub(rippleHeight(ripplePoint.add(vec3(0.12, 0, 0)))).div(0.12),
    1,
    h.sub(rippleHeight(ripplePoint.add(vec3(0, 0.12, 0)))).div(0.12),
  );
  const ground = texture(heightTexture, shoreUV(positionWorld.x, positionWorld.z));
  const local = inside(positionWorld.x, positionWorld.z);
  const depth = floorDepth(positionWorld.x, positionWorld.z, positionWorld.y);
  // The breakers this pixel is part of, drawn by the same field the vertex stage was displaced by.
  const front = breakers(shorePoint.x, shorePoint.y);
  const damp = smoothstep(0.1, 2.5, depth);
  const wind = mx_noise_float(
    vec3(positionWorld.x.mul(0.07).sub(time.mul(0.04)), positionWorld.z.mul(0.07), time.mul(0.015)),
  )
    .mul(0.6)
    .add(0.6);
  const fineFade = float(1)
    .sub(smoothstep(18, 100, eyeDistance))
    .mul(damp)
    .mul(wind);
  // The breakers carry their own slope: a crest displaced but lit flat reads as paint on glass. It is
  // clamped because a face steeper than this is a fold, and a folded normal is a black band.
  const breakerSlope = front.slope.mul(slopeFade).clamp(-0.8, 0.8);
  const normal = normalize(
    vec3(
      west.y
        .sub(east.y)
        .div(step.mul(2))
        .mul(slopeFade)
        .mul(damp)
        .add(ripple.x.mul(fineFade))
        .sub(breakerSlope.x),
      1,
      south.y
        .sub(north.y)
        .div(step.mul(2))
        .mul(slopeFade)
        .mul(damp)
        .add(ripple.z.mul(fineFade))
        .sub(breakerSlope.y),
    ),
  );
  material.normalNode = transformNormalToView(normal);
  const view = normalize(cameraPosition.sub(positionWorld));
  const bounced = view.negate().reflect(normal);
  // The standard material supplies Fresnel and the sun's specular lobe; the sky supplies the radiance.
  material.envNode = mix(color(0xb6cbd5), color(0x568fbd), clamp(bounced.y, 0, 1)).mul(1.15);
  const water = mix(OCEAN_LOOK.shallow, OCEAN_LOOK.deep, smoothstep(0.4, 9, depth));
  // A wave's white water rides its own crest; the last few centimetres of water are white whatever the
  // trains are doing, which is what leaves a wet line on the sand.
  const contact = float(1)
    .sub(smoothstep(0.05, 0.3, depth))
    .mul(smoothstep(0, 0.06, depth))
    .mul(ground.b)
    .mul(0.55);
  const shoreFoam = front.foam.mul(0.8).add(contact).max(0).min(1).mul(local);
  material.colorNode = mix(water, color(FOAM), shoreFoam.mul(0.9));
  // The surface runs to the fogged horizon, and fades into the sky there rather than ending on a hard band.
  const horizonFade = float(1).sub(smoothstep(1200, 3500, eyeDistance));
  material.opacityNode = smoothstep(-0.03, 0.35, depth).max(shoreFoam.mul(0.9)).mul(horizonFade);
  material.roughnessNode = mix(
    float(0.12).add(smoothstep(70, 700, eyeDistance).mul(0.07)),
    float(0.7),
    shoreFoam,
  );
  material.addEventListener("dispose", () => {
    heightTexture.dispose();
    frontTexture.dispose();
  });

  const mesh = new Mesh(geometry, material);
  mesh.position.y = level;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "sea-surface";
  return mesh;
}

/**
 * Adds the spectral simulation and its lit surface at the bake's sea level. The caller owns the handle.
 */
export function addCoastalSea(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  data: ICoastalSeaData,
): ICoastalSea {
  const ocean = new SpectralOcean(SEA);
  ctx.add(ocean);
  const mesh = createSeaMesh(ocean, data);
  ctx.add(mesh);
  return {
    mesh,
    ocean,
    dispose() {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as MeshStandardNodeMaterial).dispose();
      ocean.detach();
      ocean.removeFromParent();
    },
  };
}
