// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sea: a lit standard material, so the sun's glints and the sky's reflection come from the
// scene's own lights. Its colour runs from turquoise over the sand to deep blue off the shelf, read
// from a baked depth map of the island; a white wash breathes along every shore with the swell. The
// swell is core's `WaveField` (built in `level/Course.ts` and handed in), evaluated per pixel so its
// normals never repeat; two scrolling octaves of ripple normals on top break the sun's highlight
// into glitter. The ripples fade on the pixel footprint and the slope they lose becomes roughness,
// or the far sea turns into a shimmering mirror.
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  type Texture,
} from "three";
import {
  cameraViewMatrix,
  color,
  dFdx,
  dFdy,
  float,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { paintedTexture } from "./materials.js";
import { C } from "./palette.js";

/** Depth past which the sea is its deep colour, and the depth the map stores at full scale. */
const DEEP = 6;
const MAX_DEPTH = 12;

/** A square of the world, in metres, that the depth map covers. Past it the sea is deep. */
export interface ISeaFloor {
  readonly minX: number;
  readonly minZ: number;
  readonly size: number;
  /** Height of the floor (land or sea bed) at a point. */
  height(x: number, z: number): number;
  readonly seaLevel: number;
}

/** The swell's graphs, as core's `WaveField` gives them; `point` is world XZ. */
export interface ISwell {
  heightNode(options: { point: Node<"vec2">; time: Node<"float"> }): Node<"float">;
  normalNode(options: {
    point: Node<"vec2">;
    fade: Node<"float">;
    time: Node<"float">;
  }): Node<"vec3">;
}

/** The water depth over `floor`, 256² texels, red = depth / MAX_DEPTH; land reads zero. */
function depthMap(floor: ISeaFloor): DataTexture {
  const n = 256;
  const map = paintedTexture(
    n,
    n,
    (i, j) => {
      const x = floor.minX + ((i + 0.5) / n) * floor.size;
      const z = floor.minZ + ((j + 0.5) / n) * floor.size;
      const depth = Math.max(0, floor.seaLevel - floor.height(x, z));
      return [Math.min(1, depth / MAX_DEPTH), 0, 0];
    },
    false,
  );
  // Clamped, not tiled: past the map the border's open water carries on, not a copy of the island.
  map.wrapS = ClampToEdgeWrapping;
  map.wrapT = ClampToEdgeWrapping;
  map.magFilter = LinearFilter;
  map.minFilter = LinearFilter;
  return map;
}

/** Tiling ripples: periodic value noise, its slope in red/green and its height in alpha. */
function rippleMap(): DataTexture {
  const n = 256;
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
  const e = 1 / n;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const u = i / n;
      const v = j / n;
      const nx = (height(u + e, v) - height(u - e, v)) * 6;
      const nz = (height(u, v + e) - height(u, v - e)) * 6;
      const at = (j * n + i) * 4;
      data[at] = Math.max(0, Math.min(255, (nx * 0.5 + 0.5) * 255));
      data[at + 1] = Math.max(0, Math.min(255, (nz * 0.5 + 0.5) * 255));
      data[at + 2] = 255;
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

export function seaMaterial(floor: ISeaFloor, swell: ISwell): MeshStandardNodeMaterial {
  const depthTexture: Texture = depthMap(floor);
  const ripples = rippleMap();
  const at = vec2(positionWorld.x, positionWorld.z);
  const depthUv = at.sub(vec2(floor.minX, floor.minZ)).div(floor.size);
  // Outside the map the sea is deep: the map's border texels are all open water.
  const depth = texture(depthTexture, depthUv).r.mul(MAX_DEPTH);
  // The two octaves are turned 37° apart, so their rows never line up into streaks.
  const turned = vec2(at.x.mul(0.8).sub(at.y.mul(0.6)), at.x.mul(0.6).add(at.y.mul(0.8)));
  const micro = texture(ripples, at.mul(0.05).add(time.mul(vec2(0.012, 0.007))));
  const fine = texture(ripples, turned.mul(0.15).add(time.mul(vec2(-0.025, 0.018))));

  // Ripples fade where one pixel covers more ground than a ripple is wide.
  const footprint = max(length(dFdx(positionWorld)), length(dFdy(positionWorld)));
  const fade = float(1).sub(smoothstep(0.04, 0.5, footprint));
  const slope = micro.rg.mul(2).sub(1).add(fine.rg.mul(2).sub(1).mul(0.45)).mul(0.22).mul(fade);
  // The ripples ride on the swell: add their slope to the swell's.
  const big = swell.normalNode({ fade, point: at, time });
  const normalWorld = normalize(
    vec3(big.x.div(big.y).sub(slope.x), 1, big.z.div(big.y).sub(slope.y)),
  );

  // A wash that runs up and back along the shore with the swell, broken by the ripples so it is
  // never a clean line.
  const swash = sin(time.mul(1.3).sub(depth.mul(5)))
    .mul(0.18)
    .add(swell.heightNode({ point: at, time }).mul(0.8));
  const band = smoothstep(0.9, 0.15, depth.add(swash));
  const froth = smoothstep(0.45, 0.62, micro.a.mul(0.6).add(fine.a.mul(0.4)).add(band.mul(0.35)));
  const foam = band
    .mul(froth)
    .add(smoothstep(0.25, 0.05, depth).mul(0.6))
    .clamp(0, 1);

  const shallow = color(0x45d6c4);
  const shelf = color(0x2aa3c9);
  const deep = color(0x1a5aa8);
  const body = mix(
    mix(shallow, shelf, smoothstep(0.2, 2.2, depth)),
    deep,
    smoothstep(2, DEEP, depth),
  );

  // Transparent: the sand shows through the shallows and fades out over the shelf. It also keeps
  // the sea out of the post chain's normal pass, which cannot take a material's normalNode yet.
  const material = new MeshStandardNodeMaterial({ metalness: 0, transparent: true });
  material.colorNode = mix(body, color(C.foam), foam);
  material.opacityNode = max(smoothstep(0, 3, depth).mul(0.45).add(0.55), foam);
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalWorld, 0)).xyz);
  // Glossy water, rougher where the ripples have faded out and where the foam is.
  material.roughnessNode = float(0.05).add(float(1).sub(fade).mul(0.16)).add(foam.mul(0.7));
  return material;
}
