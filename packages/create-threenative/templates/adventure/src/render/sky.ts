// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A procedural misty sky and the forest's mist. The sky is a vertical gradient for the background,
// and a half-float copy of the same gradient, lifted into light units, for the environment every
// surface is filled and reflects by. No image file. The mist is height fog on `scene.fogNode`: a
// distance term (the live `FogExp2`) times a height term that thickens toward the ground, plus a
// warm glow toward the sun, so the path ahead fades into bright haze while the near ferns stay
// dark. The engine meters the frame (auto exposure) and maps it through the filmic curve, so these
// numbers say how the sky and mist relate to the sun, not how bright the screen is.
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FogExp2,
  HalfFloatType,
  InstancedMesh,
  LinearFilter,
  LinearSRGBColorSpace,
  Object3D,
  RGBAFormat,
  type Scene,
  Vector3,
} from "three";
import {
  cameraPosition,
  densityFogFactor,
  dot,
  exp2,
  float,
  fog,
  hash,
  instanceIndex,
  max,
  mix,
  normalView,
  positionViewDirection,
  positionWorld,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { palette } from "./palette.js";

/**
 * Unit vector toward the sun: high in the north-west, ahead of a camera that looks down the path,
 * so its shafts slant through the canopy toward the lens and the mist glows on that side.
 */
export const SUN_DIRECTION = new Vector3(-0.5, 0.72, -0.48).normalize();

/** The sky above the canopy, brighter than the mist under it: the forest stands against the light. */
const SKY_GLOW = 1.5;
/** How much brighter the sky's light is than its picture. The canopy keeps most of it off the floor. */
const SKY_RADIANCE = 0.45;
/** The ground half of the environment: dim green bounce off the moss. */
const GROUND_FILL = new Color(0.1, 0.13, 0.07);

/**
 * The mist, outdoors and under the Hollow's roof. `distance` is the `FogExp2` density; the height
 * term is base-2 optical depth per metre at the ground (`density`), thinning by `heightFalloff` per
 * metre up. `glow` scales the fog colour to the light under the canopy: a mist brighter than the shade
 * it hangs in washes the midground out.
 */
const MIST = {
  vale: { distance: 0.02, density: 0.008, glow: 0.55 },
  hollow: { distance: 0.006, density: 0.004, glow: 0.6 },
  heightFalloff: 0.3,
  /** Metres of clear air before the mist starts, so the ground at Wren's feet stays crisp. */
  startDistance: 10,
  /** Sun lobe sharpness: up for a tighter glow round the sun. */
  sunExponent: 5,
  /** Metres before the sun glow starts, so the near path is not tinted. */
  sunStartDistance: 6,
};
const SUN_COLOUR = new Color(0xffe2b0);
/** A shaft's added light at its brightest, in the sun's colour; the meter keeps it relative. */
const SHAFT_BRIGHTNESS = 0.4;

function gradient(elevation: number): Color {
  const high = new Color(palette.skyHigh);
  const low = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  if (elevation <= 0) return horizon;
  return elevation < 0.25
    ? horizon.lerp(low, elevation / 0.25)
    : low.lerp(high, Math.min(1, (elevation - 0.25) / 0.75));
}

function equirect(rgba: (elevation: number) => readonly number[]): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const width = 128;
  const height = 64;
  const data = new Uint16Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    // DataTexture rows start at v=0 (nadir); v=0.5 is the horizon.
    const elevation = Math.sin((row / (height - 1) - 0.5) * Math.PI);
    const texel = rgba(elevation).map(DataUtils.toHalfFloat);
    for (let column = 0; column < width; column += 1) data.set(texel, (row * width + column) * 4);
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface ISky {
  readonly background: DataTexture;
  readonly environment: DataTexture;
}

export function createSky(): ISky {
  return {
    background: equirect((e) => [...gradient(e).multiplyScalar(SKY_GLOW).toArray(), 1]),
    environment: equirect((e) => {
      const c = e < 0 ? GROUND_FILL : gradient(e).multiplyScalar(SKY_RADIANCE);
      return [c.r, c.g, c.b, 1];
    }),
  };
}

/** The height term's density at the ground; the fog node reads it every frame. */
const ground = { density: MIST.vale.density };

/**
 * `T_distance x T_height` on `scene.fogNode`: three applies it wherever `scene.fog` would apply.
 * The ray from the camera to a fragment integrates a density that halves every
 * `1 / heightFalloff` metres up, in closed form, so the low path reads hazier than the canopy at the
 * same distance. Toward the sun the mist takes the sun's colour.
 */
function mistNode(distanceFog: FogExp2) {
  const LN2 = Math.LN2;
  const color = uniform(new Color());
  color.onRenderUpdate(() => color.value.copy(distanceFog.color));
  const density = uniform(0);
  density.onRenderUpdate(() => {
    density.value = distanceFog.density;
  });
  // Density at the camera, once per frame instead of once per fragment.
  const cameraDensity = uniform(0);
  cameraDensity.onRenderUpdate(({ camera }) => {
    const y = camera?.matrixWorld.elements[13] ?? 0;
    cameraDensity.value =
      ground.density * 2 ** Math.max(-127, Math.min(127, -MIST.heightFalloff * y));
  });
  const ray = positionWorld.sub(cameraPosition);
  const length = ray.length().max(1e-4);
  const k = float(MIST.heightFalloff).mul(positionWorld.y.sub(cameraPosition.y)).div(length);
  const integral = (a: number) => {
    const b = max(length, a);
    const curved = cameraDensity
      .mul(exp2(k.mul(a).negate()).sub(exp2(k.mul(b).negate())))
      .div(k.mul(LN2));
    return select(k.mul(b).abs().lessThan(0.01), cameraDensity.mul(b.sub(a)), curved);
  };
  const heightT = exp2(integral(MIST.startDistance).negate());
  const opacity = densityFogFactor(density).oneMinus().mul(heightT).oneMinus();
  const lobe = pow(
    saturate(dot(ray.div(length), vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z))),
    MIST.sunExponent,
  );
  const glow = float(1)
    .sub(exp2(integral(MIST.sunStartDistance).negate()))
    .mul(lobe);
  const sun = new Color(SUN_COLOUR).multiplyScalar(1.4);
  return fog(mix(color, vec3(sun.r, sun.g, sun.b), glow), opacity);
}

export function setupSky(scene: Scene, sky: ISky): void {
  scene.background = sky.background;
  scene.backgroundIntensity = 1;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  scene.environment = sky.environment;
  scene.environmentIntensity = 1;
  if (scene.fog instanceof FogExp2) return;
  const distanceFog = new FogExp2(palette.horizon, MIST.vale.distance);
  distanceFog.color.multiplyScalar(MIST.vale.glow);
  scene.fog = distanceFog;
  scene.fogNode = mistNode(distanceFog);
}

/** Thins the mist under the Hollow's roof, so a room's far wall and the Warden stay clear. */
export function setMist(scene: Scene, indoors: boolean): void {
  const mist = indoors ? MIST.hollow : MIST.vale;
  ground.density = mist.density;
  if (!(scene.fog instanceof FogExp2)) return;
  scene.fog.density = mist.distance;
  scene.fog.color.set(palette.horizon).multiplyScalar(mist.glow);
}

/**
 * Sun shafts through the canopy: soft open tubes along the sun's direction, added on top of the
 * frame. A tube fades to nothing where its side turns away from the eye, at both ends and close to
 * the lens, and streaks along its length, so it reads as lit mist rather than a solid; it casts and
 * takes no light. Each entry is the x, z where a shaft meets the ground and its radius in metres.
 * Cost: one draw, a few hundred triangles, additive overdraw only where a shaft is on screen.
 */
export function sunShafts(
  feet: readonly (readonly [number, number, number])[],
  height: (x: number, z: number) => number,
): InstancedMesh {
  const length = 18;
  const material = new MeshBasicNodeMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
    transparent: true,
  });
  const facing = normalView.dot(positionViewDirection).abs();
  const along = uv().y;
  const strength = hash(instanceIndex).mul(hash(instanceIndex)).mul(0.8).add(0.2);
  const streaks = sin(
    uv()
      .x.mul(Math.PI * 14)
      .add(hash(instanceIndex.add(7)).mul(40)),
  )
    .mul(0.3)
    .add(0.7);
  material.colorNode = vec3(SUN_COLOUR.r, SUN_COLOUR.g, SUN_COLOUR.b).mul(SHAFT_BRIGHTNESS);
  material.opacityNode = pow(facing, 2.5)
    .mul(smoothstep(0, 0.12, along))
    .mul(smoothstep(1, 0.45, along))
    .mul(smoothstep(2, 7, positionWorld.distance(cameraPosition)))
    .mul(streaks)
    .mul(strength);
  const geometry = new CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0);
  const mesh = new InstancedMesh(geometry, material, feet.length);
  mesh.name = "sun-shafts";
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const place = new Object3D();
  place.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), SUN_DIRECTION);
  feet.forEach(([x, z, radius], i) => {
    place.position.set(x, height(x, z) - 0.5, z);
    place.scale.set(radius, length, radius);
    place.updateMatrix();
    mesh.setMatrixAt(i, place.matrix);
  });
  return mesh;
}
