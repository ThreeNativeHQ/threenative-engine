import { type ISpectralOceanOptions, SpectralOcean } from "@threenative/core";
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
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { IBakedWorld } from "./terrain.js";

/** This game's spectral sea state; two non-overlapping wave bands. */
export const SEA = {
  amplitude: 0.0018,
  cascades: [{ patchSize: 190 }, { patchSize: 37 }],
  choppiness: 1.2,
  directionality: 2.6,
  gravity: 9.81,
  // Keep the scenario's throttled CPU wave observations.
  readbackEveryFrames: 3,
  readbackResolution: 32,
  resolution: 128,
  seed: 20_260_906,
  smallWaveCutoff: 0.32,
  windDirection: 0.55,
  windSpeed: 10.5,
} satisfies ISpectralOceanOptions;

/** Dense inner grid; its outer vertices stretch to the distant horizon below. */
export const SURFACE = { segments: 512, size: 1024 } as const;

/**
 * The sea's two body colours as live uniforms, so an editor can retint the water without rebuilding
 * its material. The defaults are this game's look: nothing here changes it until a caller writes.
 */
export const OCEAN_LOOK = {
  deep: uniform(new Color(0x082e45)),
  shallow: uniform(new Color(0x24646a)),
};

/** Thin breaking surf on exposed shores. */
const FOAM = 0xe9f4f6;

export function createOcean(): SpectralOcean {
  return new SpectralOcean(SEA);
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
 * The sea surface: displaced by the simulation, and lit by the scene.
 *
 * The vertex stage reads the cascade buffers directly, so what is drawn is the same field the
 * height query is copied from. If the two disagreed the ship would ride water nothing renders and
 * every assertion in this template would still be green.
 */
export function createWaterMesh(ocean: SpectralOcean, data: IBakedWorld): Mesh {
  const level = data.waterLevel;
  if (level === null || !Number.isFinite(level))
    throw new Error("Coastal bake has no finite sea level");
  // Distance to dry land and connection to deep open water, measured once from the bake.
  // Flooding only through >2 m water leaves sheltered lagoons out of the breaking-surf mask.
  const n = data.resolution;
  const cell = data.size / (n - 1);
  const distance = Float32Array.from(data.heights, (height) => (height >= level ? 0 : 1e4));
  const exposed = new Uint8Array(n * n);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) {
    const row = Math.floor(i / n);
    const col = i % n;
    if (
      (row === 0 || col === 0 || row === n - 1 || col === n - 1) &&
      (data.heights[i] as number) < level - 2
    ) {
      exposed[i] = 1;
      queue.push(i);
    }
    if (col > 0) distance[i] = Math.min(distance[i] as number, (distance[i - 1] as number) + cell);
    if (row > 0) distance[i] = Math.min(distance[i] as number, (distance[i - n] as number) + cell);
  }
  for (let i = n * n - 1; i >= 0; i--) {
    if (i % n < n - 1)
      distance[i] = Math.min(distance[i] as number, (distance[i + 1] as number) + cell);
    if (i < n * (n - 1))
      distance[i] = Math.min(distance[i] as number, (distance[i + n] as number) + cell);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    for (const next of [i % n > 0 ? i - 1 : -1, i % n < n - 1 ? i + 1 : -1, i - n, i + n]) {
      if (
        next < 0 ||
        next >= exposed.length ||
        exposed[next] ||
        (data.heights[next] as number) >= level - 2
      )
        continue;
      exposed[next] = 1;
      queue.push(next);
    }
  }
  // Carry exposure through the last eighteen metres of shallow water, never across a dry sand bar.
  for (let pass = 0; pass < Math.ceil(18 / cell); pass++) {
    const previous = exposed.slice();
    for (let i = 0; i < exposed.length; i++) {
      if ((data.heights[i] as number) >= level) continue;
      if (
        (i % n > 0 && previous[i - 1]) ||
        (i % n < n - 1 && previous[i + 1]) ||
        previous[i - n] ||
        previous[i + n]
      )
        exposed[i] = 1;
    }
  }
  const pixels = new Uint16Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    pixels[i * 4] = DataUtils.toHalfFloat(data.heights[i] as number);
    pixels[i * 4 + 1] = DataUtils.toHalfFloat(distance[i] as number);
    pixels[i * 4 + 2] = DataUtils.toHalfFloat(exposed[i] as number);
  }
  const heightTexture = new DataTexture(pixels, n, n, RGBAFormat, HalfFloatType);
  heightTexture.minFilter = LinearFilter;
  heightTexture.magFilter = LinearFilter;
  heightTexture.needsUpdate = true;
  const geometry = new PlaneGeometry(
    SURFACE.size,
    SURFACE.size,
    SURFACE.segments,
    SURFACE.segments,
  );
  geometry.rotateX(-Math.PI / 2);
  // Dense near shore, sparse beyond it; the sea reaches the fogged horizon instead of ending at 512 m.
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
  const vertexLand = texture(heightTexture, shoreUV(positionLocal.x, positionLocal.z)).r;
  const vertexDepth = mix(
    float(28),
    float(level).sub(vertexLand),
    inside(positionLocal.x, positionLocal.z),
  );
  const shoal = smoothstep(0.15, 3, vertexDepth);
  const vertexDistance = positionLocal.xz.sub(cameraPosition.xz).length();
  const swellFade = float(1).sub(smoothstep(240, 1600, vertexDistance));
  material.positionNode = positionLocal.add(
    displacementAt(ocean, positionLocal.x, positionLocal.z).mul(shoal).mul(swellFade),
  );

  const eyeDistance = positionWorld.sub(cameraPosition).length();
  const slopeFade = float(1).sub(smoothstep(100, 950, eyeDistance));
  const step = float(0.45).add(eyeDistance.mul(0.006));
  const east = displacementAt(ocean, positionWorld.x.add(step), positionWorld.z);
  const west = displacementAt(ocean, positionWorld.x.sub(step), positionWorld.z);
  const north = displacementAt(ocean, positionWorld.x, positionWorld.z.add(step));
  const south = displacementAt(ocean, positionWorld.x, positionWorld.z.sub(step));
  // The river's noise-gradient detail has no directional period to read as corduroy.
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
  const shore = texture(heightTexture, shoreUV(positionWorld.x, positionWorld.z));
  const local = inside(positionWorld.x, positionWorld.z);
  const depth = mix(float(28), positionWorld.y.sub(shore.r), local);
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
  const normal = normalize(
    vec3(
      west.y.sub(east.y).div(step.mul(2)).mul(slopeFade).mul(damp).add(ripple.x.mul(fineFade)),
      1,
      south.y.sub(north.y).div(step.mul(2)).mul(slopeFade).mul(damp).add(ripple.z.mul(fineFade)),
    ),
  );
  material.normalNode = transformNormalToView(normal);
  const view = normalize(cameraPosition.sub(positionWorld));
  const bounced = view.negate().reflect(normal);
  // The standard material supplies Fresnel and the actual sun's specular lobe; the sky supplies radiance.
  material.envNode = mix(color(0xb6cbd5), color(0x568fbd), clamp(bounced.y, 0, 1)).mul(1.15);
  const water = mix(OCEAN_LOOK.shallow, OCEAN_LOOK.deep, smoothstep(0.4, 9, depth));
  const surf = mx_noise_float(
    vec3(positionWorld.x.mul(0.9), positionWorld.z.mul(0.9), time.mul(0.45)),
  )
    .mul(0.5)
    .add(0.5);
  const shoreFoam = float(1)
    .sub(smoothstep(0.25, 1.8, depth))
    .mul(smoothstep(0.015, 0.08, depth))
    .mul(float(1).sub(smoothstep(1, 5.5, shore.g)))
    .mul(smoothstep(0.25, 0.65, surf).mul(0.7).add(0.3))
    .mul(shore.b)
    .mul(local)
    .mul(0.8);
  material.colorNode = mix(water, color(FOAM), shoreFoam);
  material.opacityNode = smoothstep(-0.03, 0.35, depth).max(shoreFoam.mul(0.9));
  material.roughnessNode = mix(
    float(0.12).add(smoothstep(70, 700, eyeDistance).mul(0.07)),
    float(0.7),
    shoreFoam,
  );
  material.addEventListener("dispose", () => heightTexture.dispose());

  const mesh = new Mesh(geometry, material);
  mesh.position.y = level;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "sea-surface";
  return mesh;
}
