// Generated for you. The sea's tuning and its entire look live in this file, and ThreeNative does
// not read it. `SpectralOcean` runs the simulation and draws nothing: the mesh, the material, the
// colours, the reflection, the foam line and the tessellation are all decisions this game makes
// here.
//
// This replaces a two-wave `WaveField` under a `MeshBasicNodeMaterial`. Both halves of that were
// the problem. Two analytic waves plus one domain warp is a corrugated sheet — it repeats visibly
// within a boat length, and no amount of colour work hides a surface with two frequencies in it.
// And a *basic* material takes no lights at all, so the sea could not respond to the sun the rest
// of the scene is lit by: its brightness had to be hand-computed with a `pow(dot(n, sun), 30)`
// term standing in for a specular highlight. Water is one of the few surfaces where the specular
// *is* the material, so that read as plastic.
//
// A spectral ocean is cascaded wave spectra inverse-transformed on the GPU every frame, which is
// what real water is, and a standard node material puts it back under the scene's own lights.
import {
  type ISpectralOceanHeight,
  type ISpectralOceanOptions,
  SpectralOcean,
} from "@threenative/core";
import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  type Object3D,
  RepeatWrapping,
  Vector2,
} from "three";
import {
  Fn,
  If,
  abs,
  cameraPosition,
  color,
  dot,
  float,
  max,
  mix,
  normalWorld,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  saturate,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { palette } from "./palette.js";
import { SUN_DIRECTION } from "./sky.js";

/**
 * The sea state. Every number is this game's.
 *
 * `windSpeed` and `amplitude` are the two to reach for: wind sets which wavelengths carry energy,
 * amplitude scales the whole spectrum. `choppiness` above zero displaces horizontally as well as
 * vertically, which is what sharpens a crest into something a hull can be thrown by.
 */
export const SEA = {
  // Sea state, and the two numbers that decide whether this reads as a passage or as a puddle.
  //
  // The frame this replaces was a mirror, and the spectrum is why. `windSpeed` sets where the
  // Phillips spectrum's energy sits, through the largest wave `U²/g`: at 10.5 that is an eleven-metre
  // scale, the energy-weighted mean wavelength came out at **42 m**, and a two-metre wave 42 m long
  // is a 5% slope — a mirror with a texture on it. Nothing downstream can rescue that, because the
  // normals really are almost flat. At 6 the mean wavelength is 13 m and the same height is a 15%
  // slope, which is a sea with a shape.
  //
  // `amplitude` is the spectrum's scale, and height goes as its square root, so it was raised 15x
  // to put the crest-to-trough back where it was. Calibrated against the field the CPU actually
  // reads back, over a 70 m patch: 0.026 measured **3.15 m** trough to crest, which threw the ship
  // bodily out of the water — the line of sight to its own keel cleared the sea half a metre astern
  // and the whole hull, rudder and all, hung above the surface in almost every frame. 0.0038
  // measures about 1.3 m, against 0.7 m of freeboard: the caravel is thrown, its rail is awash on
  // the biggest crests, and its keel is under the water.
  amplitude: 0.0046,
  // Largest patch first, and the bands do not overlap. One cascade is a toy — the join between
  // bands is where a spectral ocean visibly fails, so there is nothing to look at until there are
  // two. A third was measured and carries 0.01 m of the total: the 1/k⁴ term has already spent the
  // short waves by the time a 9 m patch's band begins, so it buys nothing and costs two more reads
  // in the vertex stage.
  cascades: [{ patchSize: 190 }, { patchSize: 37 }],
  choppiness: 1.2,
  directionality: 2.6,
  gravity: 9.81,
  // The ship reads this field on the CPU for its buoyancy and its attitude, so the copy has to
  // land often enough — and be fine enough — to steer by.
  //
  // 32 samples across the largest patch is one height every six metres, which is coarser than the
  // waves themselves: the hull then sat at a smoothed mean sea level while the drawn surface moved
  // three metres either side of it, so the ship hung in the air over its own troughs and pitched
  // on differences between samples that were nowhere near it. 64 halves that spacing, and the
  // calmer sea state below closes the rest of the gap. This is the cost of a spectral ocean over
  // an analytic one, and it is worth paying — but it has to be paid.
  readbackEveryFrames: 3,
  // 64, and the paragraph above is the reason: at 32 the copy carried one height every six metres
  // across the broad cascade, which is coarser than the ship is long, so both hull probes landed
  // in the same cell and the ship barely answered the sea it was in.
  readbackResolution: 64,
  resolution: 128,
  seed: 20_260_906,
  // The length below which the spectrum is damped out, in metres. 0.32 was a 2 m wavelength, which
  // is where the geometric ripple normals already take over, so the sea was throwing away its whole
  // last octave and reading as glass. 0.12 keeps it to about 1.2 m: short enough to carry a
  // glitter path, long enough that the surface is not aliased into sparkle as the camera moves.
  smallWaveCutoff: 0.12,
  windDirection: 0.55,
  windSpeed: 6,
} satisfies ISpectralOceanOptions;

/** Predict this point's current height from its measured local vertical velocity. */
export function surfaceHeight(
  ocean: SpectralOcean,
  x: number,
  z: number,
  deltaTime: number,
): number | undefined {
  const probe = ocean.sampleHeight(x, z);
  if (probe === undefined) return undefined;
  const lead = Math.max(0, probe.staleFrames) * deltaTime;
  return probe.height + probe.verticalVelocity * lead;
}

/**
 * A new asynchronous copy corrects the predicted height and velocity. Carry that innovation
 * continuously to the new prediction over its measured copy interval, rather than teleporting
 * the hull or damping the wave itself. Each ship owns its history; attitude probes stay raw.
 */
export function createHeightReconciler() {
  let previous:
    | { height: number; velocity: number; copy: number; time: number; step: number }
    | undefined;
  let curve: { start: number; duration: number; height: number; velocity: number } | undefined;
  const correction = (time: number) => {
    if (curve === undefined || time >= curve.start + curve.duration)
      return { height: 0, velocity: 0 };
    const t = Math.max(0, (time - curve.start) / curve.duration);
    return {
      height:
        (2 * t ** 3 - 3 * t ** 2 + 1) * curve.height +
        (t ** 3 - 2 * t ** 2 + t) * curve.duration * curve.velocity,
      velocity:
        ((6 * t ** 2 - 6 * t) * curve.height) / curve.duration +
        (3 * t ** 2 - 4 * t + 1) * curve.velocity,
    };
  };
  return (sample: ISpectralOceanHeight, frame: number, step: number) => {
    if (
      ![frame, step, sample.height, sample.verticalVelocity, sample.staleFrames].every(
        Number.isFinite,
      ) ||
      frame < 0 ||
      step <= 0 ||
      sample.staleFrames < 0
    )
      throw new Error("Invalid sailing height prediction clock or sample.");
    const time = frame * step;
    const copy = (frame - sample.staleFrames) * step;
    const height = sample.height + sample.verticalVelocity * (time - copy);
    if (
      previous !== undefined &&
      (time < previous.time || step !== previous.step || copy < previous.copy)
    ) {
      previous = undefined;
      curve = undefined;
    }
    if (previous !== undefined && copy !== previous.copy) {
      const carried = correction(time);
      curve = {
        start: time,
        duration: copy - previous.copy,
        height:
          previous.height + previous.velocity * (time - previous.copy) + carried.height - height,
        velocity: previous.velocity + carried.velocity - sample.verticalVelocity,
      };
    }
    previous = { height: sample.height, velocity: sample.verticalVelocity, copy, time, step };
    const carried = correction(time);
    return {
      height: height + carried.height,
      verticalVelocity: sample.verticalVelocity + carried.velocity,
      correction: carried.height,
    };
  };
}

/**
 * The drawn surface, as a logarithmic disc: rings of quads whose spacing grows with the radius.
 *
 * A square patch cannot do this job at any size. A 300 m square nailed to the ship puts its far
 * edge a hundred and fifty metres out, which is inside the haze, so the player sails to a visible
 * rectangular hem where the sea stops and the photograph starts; and a square big enough to reach
 * the horizon needs 300 m quads near the ship, which is coarser than the waves and throws away
 * everything the cascade buffers are carrying. Rings solve both at once: the innermost quad is a
 * third of a metre beside the hull and the outermost is half a kilometre at the horizon, for
 * *fewer* triangles than the 128×128 grid this replaced.
 */
export const SURFACE = {
  /** Quads around the circle. */
  segments: 160,
  /** Rings from the ship to the horizon. */
  rings: 96,
  /** Radius of the first ring, in metres. */
  inner: 1.5,
  /** Radius of the last ring. Past the eye's own horizon at this height, and fully hazed. */
  reach: 6_000,
} as const;

/**
 * The step the surface normal is differenced over, in metres.
 *
 * Deliberately finer than the mesh's own quad, which is a third of a metre here. Differencing at
 * the quad size throws away every wave shorter than about four metres *before it can shade
 * anything*, and a sea with no short waves in its normals has no glitter: the sun arrives as one
 * smooth mirror lobe a third of the frame wide, blooms, and blows out. Shading detail below the
 * geometric resolution is the whole point of a normal, and the fine cascade already carries it at
 * 0.29 m per texel. This sits between the two: fine enough to break the highlight into a glitter
 * path, coarse enough not to alias into sparkle noise as the camera moves.
 */
const NORMAL_STEP = 0.7;

/** Crest foam, whitecap and hull wash. Near-white, and not a seventh palette role: the sea's look is owned here. */
const FOAM = 0xd6e6ea;

/**
 * Light coming **through** a wave, which is what makes a crest read as water and not as a ridge.
 *
 * A backlit crest is lit from behind by the sun under the water, and that light is green. It only
 * shows where the face is turned away from the sun and high enough to be near the surface, so it
 * is a product of the face's own slope and its height — which is why it costs two nodes and no
 * texture.
 */
const SUBSURFACE = 0x1f6a4c;

/**
 * How much of the mirror the sea shows.
 *
 * The mirrored pass draws the world *and the sky behind it*, so what arrives in this texture is a
 * photograph of the clouds. That is the whole defect the owner is looking at: a planar mirror of a
 * partly-cloudy sky reflects every cumulus crisply across six kilometres of water, and a sea that
 * does that is a lake. The sky is therefore **not in the mirror** — see `sky.ts`, where the dome
 * lives on layer 0 and the mirror draws layer 1 only — so what is left in here is the hull, the
 * marks and the headland: the silhouettes a player reads in the water, and the one thing a
 * prefiltered environment cannot do for a sea.
 *
 * Below one because a render target is written linear, where the screen is tone-mapped, so what
 * arrives is the raw 2.5-range photograph and the water would mirror it at full stops.
 */
const MIRROR_GAIN = 0.55;

/**
 * The layer the water's mirror draws. An object on it is **also** on layer 0, so the main camera
 * is unaffected and only the mirrored pass narrows.
 *
 * It is the hull, the marks and the headland — the silhouettes a player actually reads in the
 * water. The sea itself is not on it, which is what stops the mirror from redrawing the mirror,
 * and the sky is not on it because the sky arrives through `reflectedSky` instead: the mirrored
 * pass is a second draw of the world, and putting a 4096-wide photograph in it would buy a
 * lower-resolution copy of a lookup this material can already do for free.
 */
export const REFLECTED_LAYER = 1;
/**
 * How the sea's mirror is built. The *decision* lives here; the construction is the scene's,
 * because `src/render/` reaches the engine only for the wave simulation it draws.
 *
 * Half is the honest resolution for a reflection seen through moving water — the surface itself is
 * the blur, and a sharp half-res copy of a hull in a swell reads no better than a soft full-res
 * one. The layer mask is what keeps the pass affordable: it is a second draw of the world, so
 * `markReflected` is what names the handful of objects worth paying for.
 */
export const SEA_MIRROR = {
  level: 0,
  // Never read: this sea is deep everywhere and has no bed to see. The option is required, and
  // this is the depth of water a fully hazed fragment stands behind.
  maxThickness: 24,
  reflection: { resolutionScale: 0.5, layers: 1 << REFLECTED_LAYER },
} as const;

/** The one thing this material asks of the mirror. Structural, so the type is not an import. */
interface ISeaMirror {
  reflectionAt(offset?: Node<"vec2">): Node<"vec3">;
  dispose(): void;
}

/**
 * Put an object in the mirror, and every child of it. Layers are not inherited in three, so a
 * merged hull of seven meshes needs the walk.
 */
export function markReflected(object: Object3D): void {
  object.traverse((part) => part.layers.enable(REFLECTED_LAYER));
}

export function createOcean(): SpectralOcean {
  return new SpectralOcean(SEA);
}

/**
 * Read one cascade's displacement at a world position, **bilinearly**.
 *
 * Nearest-texel sampling is the obvious way to write this and it is visibly wrong here. The mesh
 * carries one vertex per 0.3 m while the fine cascade's texel is 0.29 m, so every vertex grabbed a
 * different texel of a field it was far too coarse to resolve — and the normal, being a difference
 * of two of those, came out piecewise-constant. The frame showed the sun's reflection broken into
 * hard axis-aligned white rectangles, which is a sampling artefact and reads as a bug in the water.
 *
 * The two `mod`s are not redundant: the first is still negative for a vertex left of the origin,
 * and a negative index reads whatever happens to sit behind the buffer.
 */
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

/** A sea surface, and the handle that keeps it under the ship. */
export interface IWaterSurface {
  readonly mesh: Mesh;
  /** Move the drawn sea to follow a position, keeping the wave field anchored to the world. */
  follow(x: number, z: number): void;
  /** The sea's own clock, for the ripple normals. The wave field has the game's `advance`. */
  advance(elapsed: number): void;
  /**
   * Where the ship is, which way it is pointing, and how hard it is pushing water aside.
   *
   * `strength` is 0..1 and is the speed made good over the hull's own maximum: a ship lying to
   * with no way on leaves no wake, which is the point.
   */
  wake(x: number, z: number, forwardX: number, forwardZ: number, strength: number): void;
  /** Releases the mirror's render target. The scene calls this on `exit`. */
  dispose(): void;
}

/**
 * The wake's shape: how far astern it reaches in metres, how fast the wedge opens, and how wide it
 * is at the transom.
 *
 * The half-angle of a real Kelvin wedge is about nineteen degrees whatever the hull is doing,
 * which is a `spread` near 0.34 — and at that width, over thirty-four metres, the wake covers so
 * much of a low-camera frame that it stops reading as a wake and becomes a pale smear across the
 * bottom third. Narrower and shorter is the lie worth telling.
 */
const WAKE = { length: 26, spread: 0.21, waist: 0.5 } as const;

/**
 * The wash the hull stands in, as half of the hull's length and beam in metres.
 *
 * A ship that leaves the surface exactly as it found it is a model on a backdrop. This is the ring
 * of broken water at its own waterline: the ellipse is the hull's plan, `wash` is the band just
 * outside it, and it is strongest under way because it is `wakeStrength` — a ship lying to with no
 * way on stops pushing water aside, which is the point. The numbers are the hull's own, from
 * `HULL_STATIONS` in `props.ts` after the 4.6 m normalisation.
 */
const HULL_WASH = { halfBeam: 0.62, halfLength: 2.35 } as const;

/**
 * The ripples, as a 256² normal map made of periodic value noise — no file, no fetch, no bytes.
 *
 * The FFT carries energy down to 0.29 m and the geometry can only be tessellated so far, so the
 * last two octaves of a real sea — the chop between the wave crests — have to come from somewhere
 * that is not the mesh. Two scrolling octaves of this are what break the sun's highlight into a
 * glitter path instead of one blown lobe, and they are the reason a wave crest has a skin on it.
 */
function rippleNormals(): DataTexture {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  // Periodic value noise on a `k`-cell grid, so the texture tiles without a visible seam.
  const hash = (x: number, z: number): number => {
    const a = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return a - Math.floor(a);
  };
  const noise = (u: number, v: number, k: number): number => {
    const x = u * k;
    const z = v * k;
    const i = Math.floor(x);
    const j = Math.floor(z);
    let a = x - i;
    let b = z - j;
    a = a * a * a * (a * (a * 6 - 15) + 10);
    b = b * b * b * (b * (b * 6 - 15) + 10);
    const h = (hx: number, hz: number): number => hash(((hx % k) + k) % k, ((hz % k) + k) % k);
    return (
      (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) +
      (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b
    );
  };
  const height = (u: number, v: number): number =>
    noise(u, v, 8) * 0.58 +
    noise(u, v, 16) * 0.28 +
    noise(u, v, 32) * 0.11 +
    noise(u, v, 64) * 0.03;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const v = j / n;
      const e = 1 / n;
      const nx = (height(u + e, v) - height(u - e, v)) * 6;
      const nz = (height(u, v + e) - height(u, v - e)) * 6;
      const at = (j * n + i) * 4;
      data[at] = Math.max(0, Math.min(255, (nx * 0.5 + 0.5) * 255));
      data[at + 1] = Math.max(0, Math.min(255, (nz * 0.5 + 0.5) * 255));
      data[at + 2] = 240;
      data[at + 3] = height(u, v) * 255;
    }
  }
  const map = new DataTexture(data, n, n);
  map.wrapS = RepeatWrapping;
  map.wrapT = RepeatWrapping;
  map.magFilter = LinearFilter;
  map.minFilter = LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
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
 * The slope of the swell at a world position, by central difference.
 *
 * Without this the surface is lit by the flat plane's normals — every vertex pointing straight up
 * — and a perfectly simulated ocean shades like a sheet of paper. The step is `NORMAL_STEP`, not
 * the mesh's quad; see the note on that constant.
 */
function surfaceSlope(ocean: SpectralOcean, x: Node<"float">, z: Node<"float">): Node<"vec2"> {
  const step = float(NORMAL_STEP);
  const east = displacementAt(ocean, x.add(step), z);
  const west = displacementAt(ocean, x.sub(step), z);
  const north = displacementAt(ocean, x, z.add(step));
  const south = displacementAt(ocean, x, z.sub(step));
  const twice = step.mul(2);
  return vec2(west.y.sub(east.y).div(twice), south.y.sub(north.y).div(twice));
}

/**
 * Two scrolling octaves of the ripple map, as a slope in the same units as `surfaceSlope`.
 *
 * Only ever called inside an `Fn`, because `If` needs a shader stage to build against — and it is
 * called from two of them, one per stage, which is why it returns a graph rather than a value.
 */
function rippleSlope(ripples: DataTexture, time: Node<"float">, fade: Node<"float">): Node<"vec2"> {
  const slope = vec2(0, 0).toVar();
  If(fade.greaterThan(0.02), () => {
    const micro = texture(
      ripples,
      vec2(positionWorld.x, positionWorld.z)
        .mul(vec2(0.022, 0.045))
        .add(time.mul(vec2(0.006, 0.003))),
    );
    const finer = texture(
      ripples,
      vec2(positionWorld.x, positionWorld.z)
        .mul(vec2(0.1, 0.075))
        .add(time.mul(vec2(-0.014, 0.009))),
    );
    slope.assign(micro.rg.mul(2).sub(1).add(finer.rg.mul(2).sub(1).mul(0.32)));
  });
  return slope;
}

export function createWaterMesh(
  ocean: SpectralOcean,
  mirror: ISeaMirror,
  options: { readonly software?: boolean } = {},
): IWaterSurface {
  // A CPU rasteriser draws this material's full graph (cascade normals, foam, wake, mirror) so
  // slowly that the sea-height readback never lands inside a scenario's ticks (measured on four
  // cores: `readbackStaleFrames` stays -1 with the full graph and lands with this one).
  // `ctx.renderer.softwareAdapter` names that machine; the swell, the readback and the hull still
  // run, and only the shading that needs a GPU is left off.
  const cheap = options.software === true;
  const geometry = seaDisc();
  const ripples = rippleNormals();

  // Where the drawn patch sits in the world.
  //
  // The disc is nailed to the ship rather than to the origin, and the field it reads does **not**
  // travel with it — the cascade lookup adds this offset back, so a wave stays where it is in the
  // world while the mesh slides underneath it. Without that the whole ocean would be dragged along
  // by the ship and the sea would appear to stand still.
  const seaOrigin = uniform(new Vector2());
  const seaTime = uniform(0);
  const shipOrigin = uniform(new Vector2());
  const shipForward = uniform(new Vector2(0, -1));
  const wakeStrength = uniform(0);

  // Standard, not basic. This is the whole reason the sea has a sun on it rather than a
  // hand-rolled `pow()` blob: a lit material gets the scene's key light and its specular response
  // for free, and gets them consistent with the hull floating on it.
  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    // The sun's own highlight is the one term this material does **not** need help with, and it is
    // the term that ruins the frame when it is too sharp. A GGX lobe at 0.16 peaks thousands of
    // times brighter than its own average, and a low chase camera sees most of the sea at a
    // grazing angle — so the peak lands across a third of the water at once and ACES turns the
    // whole middle distance into a white sheet. The sea is rough instead (see `roughnessNode`),
    // which spreads the same energy over several times the area: the glitter path is still a
    // glitter path, and the sea around it is still sea.
    roughness: 0.13,
  });
  // **On**, and this is the fix for the mirror the owner is looking at. `scene.environment` is the
  // sky photograph, three prefilters it, and a standard material's image-based specular then reads
  // that prefiltered sky *at this fragment's own roughness* — a rough, blurred sky reflection,
  // Fresnel-weighted by the same Schlick curve the rest of the scene's materials use. Looked
  // straight down into, water reflects about 2%; looked along, it reflects nearly all of it. A
  // hand-written `pow(1 - N·V, 5)` on a planar mirror photograph cannot do either of those things
  // and is why every sea past a hundred metres was one even sheet of cloud.
  material.envMapIntensity = 0.32;

  const worldX = positionLocal.x.add(seaOrigin.x);
  const worldZ = positionLocal.z.add(seaOrigin.y);
  const offset = displacementAt(ocean, worldX, worldZ);
  material.positionNode = positionLocal.add(offset);

  const eye = cameraPosition.sub(positionWorld);
  const distance = eye.length();
  // How far off the ship a ripple can still be told apart, from range alone. A vertex shader cannot
  // ask how big its own fragment is, so this is the vertex stage's half of the answer and
  // `subpixel` below is the fragment stage's.
  const far = float(1).div(distance.mul(0.003).add(1));

  // How much of a wave a pixel can still resolve, as a 0..1 fraction. Past a ~4 m footprint the
  // swell is sub-pixel and the ripples mip to flat, which is what turned every sea beyond ~130 m
  // into a mirror. The slope that is lost does not vanish physically, it becomes roughness — so it
  // is spent as roughness below, on both the mirror and the sun.
  const footprint = positionWorld.dFdx().length().max(positionWorld.dFdy().length());
  const subpixel = smoothstep(0.4, 4, footprint);
  const detail = far.mul(oneMinus(subpixel));

  // The swell's own slope, once, in the vertex stage. `transformNormalToView`, not the raw vector:
  // `normalNode` overrides `normalView`, so a material handed a world-space normal lights the
  // surface in the camera's frame instead of the world's — the sun's reflection stopped being a
  // place on the sea and became a column of glare pointing at the camera.
  if (!cheap)
    material.normalNode = Fn(() => {
      const slope = surfaceSlope(ocean, worldX, worldZ);
      return transformNormalToView(vec3(slope.x.negate(), 1, slope.y.negate()).normalize());
    })();

  // Colour by height: deep blue-green in the troughs, lit water on the shoulders, foam on the
  // crests.
  //
  // These numbers are in metres of wave height, so they move with `SEA.amplitude` and are wrong the
  // moment it changes. The sea state above measures 1.99 m crest to trough, so the surface runs
  // about -0.65 m to +0.65 m and the band has to sit inside that: a band centred on zero is above its
  // own threshold across half the sea and the water comes back one even mid teal from bow to
  // horizon. Put the band where the crests are and the sea is deep water everywhere except its
  // tops, which is the only way a height ramp reads as a swell.
  const shade = smoothstep(float(-0.5), float(0.4), positionWorld.y);
  const water = mix(color(palette.floor), color(palette.accent), shade);
  // The light coming through a wave from behind, which is green and is the difference between a
  // crest and a ridge. It needs a face turned away from the sun and a height near the surface, so
  // it is the product of the two, and it is added rather than mixed so a deep trough stays deep.
  const through = saturate(
    normalWorld.dot(vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).negate()),
  )
    .mul(shade)
    .mul(0.26);
  // Foam on the tops, not on the faces. The band has to sit near the **highest** water the field
  // reaches, not near its mean: a threshold clearing across whole wave faces at once reads as snow
  // rather than as sea. A field this size is a normal distribution about its mean with a standard
  // deviation near 0.25 m, and at 0.46 m and 0.74 m that is the top one to three per cent of the
  // surface — which is what whitecaps are, and it is the top of the distribution that breaks, not
  // the mean. The band that came back first was at 0.55 m on a field twice this size, which is barely
  // one deviation: a third of the sea came back white and the frame read as pack ice.
  //
  // A height band alone gives foam a *contour line*, because a smooth wave crossing a smooth
  // threshold is a smooth curve: the crests came back as glossy white ribbons laid along the sea,
  // which read as plastic rather than as water. One more octave of the ripple map tears the edge,
  // and it is the same texture the normals already read, so it costs one fetch.
  //
  // **Remapped so it reaches zero.** It used to run 0.45 to 1.0, which is a tint and not a tear:
  // multiplied into the wake it left every fragment of foam at least 45% opaque, and a hard white
  // U came down the frame from under the stern of a ship making no way at all. Foam is patches —
  // there is water between them, and the mask has to say so or it is a decal.
  const torn = Fn(() => {
    const grain = texture(
      ripples,
      vec2(positionWorld.x, positionWorld.z).mul(0.26).add(seaTime.mul(0.02)),
    ).a;
    return smoothstep(float(0.4), float(0.74), grain);
  })();
  const crest = smoothstep(float(0.46), float(0.74), positionWorld.y).mul(torn);

  // The wake, computed rather than drawn.
  //
  // A hull moving through water at six knots that leaves the surface exactly as it found it is the
  // single clearest tell that a sea is a backdrop rather than something the ship is in — and it
  // was, because nothing in this material knew the ship existed. This costs no geometry, no
  // particles and no second pass: the surface already knows its own world position, so it can be
  // told where the ship is and work out whether it is standing in its wake.
  //
  // Everything is in the ship's frame. `astern` is metres behind it and `across` is metres off its
  // centreline, so the wedge is a comparison rather than a rotation.
  const toShip = vec2(positionWorld.x.sub(shipOrigin.x), positionWorld.z.sub(shipOrigin.y));
  const starboardAxis = vec2(shipForward.y.negate(), shipForward.x);
  const astern = dot(toShip, shipForward).negate();
  const across = abs(dot(toShip, starboardAxis));
  // A Kelvin wedge, and it needs both of its parts.
  //
  // Filling the wedge evenly gives a soft triangle that reads as haze on the water. What a wake
  // actually looks like from astern is a churned band directly behind the transom with two bright
  // arms running out from it at the edges of the wedge, and the arms are the half of it the eye
  // recognises: they are the only straight lines in a scene made entirely of swell.
  const halfWidth = astern.mul(WAKE.spread).add(WAKE.waist);
  const churn = smoothstep(halfWidth.mul(0.62), halfWidth.mul(0.12), across).mul(0.6);
  const arms = smoothstep(halfWidth.mul(0.5), float(0), abs(across.sub(halfWidth)));
  const reach = smoothstep(float(WAKE.length), float(0), astern);
  const begins = smoothstep(float(-1.4), float(1.6), astern);
  // Never quite to full foam. At 1.0 the arms are the brightest thing in the frame and read as two
  // searchlights laid on the sea rather than as broken water.
  //
  // Torn by the same grain as the whitecaps, and this is the term that has to have it. `arms` is
  // the only straight line in a scene made entirely of swell, so an untiled one is read as a line
  // somebody drew: the frame came back with a hard white U running from under the stern to the
  // bottom edge, off a hull making no way at all.
  const wake = max(churn, arms).mul(reach).mul(begins).mul(wakeStrength).mul(torn).mul(0.78);
  // The wash at the hull's own waterline: an ellipse in the ship's plan, and a band just outside
  // it. Cheaper than the wake and it is the half the player is closest to — without it the hull
  // meets the sea on a clean line, and a clean line is the tell that nothing here is water.
  const plan = vec2(astern.div(HULL_WASH.halfLength), across.div(HULL_WASH.halfBeam));
  //
  // **Gated on way on**, which it was not, and that was the other half of the U. A hull lying to
  // is not working water against its own topsides — it is sitting in it — and the lie this told
  // was a bright unbroken annulus around a stationary ship, which the eye reads as a decal rather
  // than as a wake no matter how well it is torn. Under way it is a ring of broken water at the
  // waterline; at rest there is nothing, and the hull sits in a swell like anything else.
  //
  // The band is a quarter as wide as the ellipse's own radius and the edges are soft, because a
  // narrow hard ring at this distance photographs as a drawn circle however broken its fill is.
  const wash = smoothstep(float(1.34), float(0.94), plan.length()).mul(
    smoothstep(float(0.62), float(0.94), plan.length()),
  );
  // Plus a little standing white at the bow, where the stem pushes a bow wave ahead of it.
  //
  // Bounded ahead as well: `smoothstep` with its edges reversed clamps to 1 on the far side, so
  // without the second ramp this was a strip of foam from the stem to the horizon.
  const bow = smoothstep(float(-1.4), float(-2.5), astern)
    .mul(smoothstep(float(-5), float(-3.5), astern))
    .mul(smoothstep(float(1.3), float(0.2), across))
    .mul(wakeStrength)
    .mul(torn);
  const broken = max(max(wake, bow), wash.mul(torn).mul(wakeStrength));
  material.colorNode = cheap
    ? water
    : mix(water.add(color(SUBSURFACE).mul(through)), color(FOAM), max(crest, broken));

  // The one thing the prefiltered environment cannot do: the hull, the marks and the headland, in
  // the water, sharp.
  //
  // Fresnel is the term that decides how much. The sky's own reflection is already handled above by
  // the material's image-based specular, which applies the same Schlick curve on its own; this
  // applies the same one to the mirror, so the two agree at the horizon and the silhouettes fade
  // out as the eye comes down onto the water.
  if (!cheap)
    material.emissiveNode = Fn(() => {
      // The interpolated vertex normal, which is the swell, plus this fragment's own ripple. Adding
      // the ripple here rather than in the vertex stage is what makes it affordable: the swell's
      // central difference is four cascade reads, and doing that per *fragment* on a full-screen sea
      // cost sixteen texture fetches a pixel to arrive at a vector the vertex stage had already
      // computed. The ripple is a texture read either way, and per fragment is finer, which is the
      // whole point of a normal map.
      const normal = normalWorld
        .add(vec3(rippleSlope(ripples, seaTime, detail).mul(-0.47).mul(detail), 0))
        .normalize();
      const facing = saturate(dot(normal, eye.normalize()));
      // Exponent five is water's own Schlick curve, and the 0.97963/0.02037 pair is its reflectance
      // at the horizon and at normal incidence.
      const fresnel = pow(oneMinus(facing), float(5)).mul(0.97963).add(0.02037);
      // The normal's own slope is the offset: it is the same slope that is bending the light, so the
      // mirror wobbles with the wave it is standing on.
      const reflected = mirror.reflectionAt(normal.xz.mul(0.02)).mul(MIRROR_GAIN);
      // Rough water does not mirror at grazing angles the way a flat facet does: the microfacets that
      // survive are not aligned with the view, so reflectance falls off with roughness.
      const rough = max(crest, broken);
      return reflected.mul(fresnel).mul(oneMinus(max(subpixel, rough).mul(0.75)));
    })();
  // Roughness is spent, not lost: the slope a distant pixel can no longer resolve reappears here.
  //
  // This is now the term that decides the whole look, because it is what the prefiltered sky is
  // sampled at. A sea at 0.13 returns a sharp horizon and a broken cloud; at 0.5 it returns a broad
  // luminous sheet, which is a mirror again. **Sharp is the word that matters here**: a rough
  // surface *averages* the sky over a wide cone, so every facet returns nearly the same pale value
  // and the wave shape disappears into a field of ice — which is exactly what the first two frames
  // looked like. A sharp one returns a different piece of sky per facet and the shape comes back.
  // Near the ship the ripple normals carry the detail, and past the point where a pixel can no
  // longer resolve a metre of wave the roughness takes over and the middle distance turns into the
  // soft band a real sea shows. Broken water is not a mirror either, and roughening it is what
  // stops the foam reading as chrome.
  if (!cheap)
    material.roughnessNode = max(float(0.13).add(subpixel.mul(0.3)), max(crest, broken).mul(0.9));

  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "sea-surface";

  // Snapped, because following continuously would slide every vertex through the wave field by a
  // fraction of its size every frame and the surface would visibly crawl. A whole-metre step is
  // coarse enough to stop the crawl and fine enough that the snap itself cannot be seen.
  return {
    mesh,
    advance(elapsed: number): void {
      seaTime.value = elapsed;
    },
    wake(x: number, z: number, forwardX: number, forwardZ: number, strength: number): void {
      shipOrigin.value.set(x, z);
      shipForward.value.set(forwardX, forwardZ);
      wakeStrength.value = Math.max(0, Math.min(1, strength));
    },
    follow(x: number, z: number): void {
      const snappedX = Math.round(x);
      const snappedZ = Math.round(z);
      mesh.position.set(snappedX, 0, snappedZ);
      seaOrigin.value.set(snappedX, snappedZ);
    },
    dispose(): void {
      mirror.dispose();
      ripples.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
