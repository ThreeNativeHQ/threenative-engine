// Generated for you. The sky is game-owned source, not an engine preset.
import {
  BackSide,
  BufferAttribute,
  Color,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  type Scene,
  SphereGeometry,
  Vector3,
} from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

const CLEAR_FOG = new Color(palette.skyLow);
const STORM_FOG = new Color(0xafc3d1);

/** The look this fog replaced: FogExp2 at 0.016, measured at 40 m from 2 m up. */
const EYE_LEVEL = { density: 0.016, distance: 40, cameraHeight: 2 };

/**
 * The distance term's density that, with the height term, keeps the old eye-level haze: at
 * `EYE_LEVEL.distance` along the horizon from `EYE_LEVEL.cameraHeight` the two together transmit what
 * FogExp2 at `EYE_LEVEL.density` did. The distance term is lowered, never removed, so the ground
 * still ends in fog at a kilometre.
 */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

/** A graded dome with a warm sun glow, plus the haze; returns how to darken both for a storm. */
export function setupSky(scene: Scene): (storm: number) => void {
  const RADIUS = 450;
  const geometry = new SphereGeometry(RADIUS, 40, 24);
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const top = new Color(palette.skyHigh);
  const bottom = new Color(0xd6e2ea);
  const sunGlow = new Color(0xffeedd);
  const sun = { x: -0.6, y: 0.57, z: -0.56 };
  const current = new Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index) / RADIUS;
    const y = Math.max(0, positions.getY(index) / RADIUS);
    const z = positions.getZ(index) / RADIUS;
    current.copy(bottom).lerp(top, y ** 0.58);
    const toward = Math.max(0, x * sun.x + y * sun.y + z * sun.z);
    current.lerp(sunGlow, toward ** 20 * 0.35);
    colors.set([current.r, current.g, current.b], index * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  const material = new MeshBasicMaterial({
    fog: false,
    side: BackSide,
    toneMapped: false,
    vertexColors: true,
  });
  const dome = new Mesh(geometry, material);
  dome.frustumCulled = false;
  dome.renderOrder = -100;
  scene.background = bottom;
  scene.add(dome);
  const fog = new FogExp2(CLEAR_FOG.getHex(), distanceDensity());
  scene.fog = fog;
  scene.fogNode = heightFogNode(fog, HEIGHT_FOG, new Vector3(sun.x, sun.y, sun.z));
  return (storm) => {
    fog.color.copy(CLEAR_FOG).lerp(STORM_FOG, storm);
    // Thick enough to swallow the far forest, thin enough that the explorer stays readable.
    fog.density = distanceDensity() + storm * 0.05;
    material.color.setScalar(1 - storm * 0.3);
  };
}
