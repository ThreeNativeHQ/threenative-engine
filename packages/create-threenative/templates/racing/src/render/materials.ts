// Generated for you. The car's livery and the circuit's surfaces. ThreeNative does not read this
// file, and nothing in `shapes.ts` names a colour — it only names these slots. Re-livery the car,
// or repaint the circuit, entirely from here.
//
// The look is a real circuit's: dark grey asphalt with a fine grain and a darker rubber band down
// the racing line, white edge lines, red and white kerbing, green grass with a slow variation, and
// one saturated colour for the things a driver is meant to react to. The asphalt and the grass are
// built from bytes rather than shipped as files, so they cost nothing to load and run the same in
// the browser and in the native host.
import {
  type BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";
import { palette, toon } from "./palette.js";

/** Deterministic per-texel noise, so two captures of the same build look the same. */
function noise(x: number, y: number, seed: number): number {
  let state = (x * 73856093) ^ (y * 19349663) ^ (seed * 83492791);
  state = (state ^ (state >>> 13)) >>> 0;
  state = (state * 1274126177) >>> 0;
  return ((state ^ (state >>> 16)) >>> 0) / 4294967295;
}

/** Smoothstep, so the rubber band has a soft edge instead of a stripe painted across the road. */
function falloff(value: number, edge: number): number {
  const t = Math.min(Math.max((Math.abs(value) - edge) / 0.28, 0), 1);
  return t * t * (3 - 2 * t);
}

function rgbaTexture(
  size: number,
  shade: (x: number, y: number) => [number, number, number],
): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = shade(x / size, y / size);
      const at = (y * size + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 16;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Asphalt: mid-dark grey, a fine per-texel grain, and a darker band down the middle where every
 * car lays rubber. The band is the thing that makes a road read as a **racing** surface rather
 * than a grey plane — it also tells the player where the line is without a single word of UI.
 */
// Not applied to the road yet, so it is prefixed rather than deleted: wiring it in changes the look.
const _asphalt = rgbaTexture(256, (u, v) => {
  const grain = (noise(Math.floor(u * 256), Math.floor(v * 256), 11) - 0.5) * 26;
  const rubber = 1 - 0.34 * falloff(u - 0.5, 0.16);
  const shoulder = 1 + 0.1 * falloff(u - 0.5, 0.42);
  // No term here may depend on `v` except through `grain`: the road tiles this image every 8 m of
  // travel, and a v-dependent brightness curve (there used to be one, `sin(u*9.1+v*3.7)`) does not
  // return to its own start at v=1, so every tile boundary was a visible seam — a hard band across
  // the whole road width, every 8 m, the length of the circuit. `grain` is safe: it is per-texel
  // hashed noise with no trend across the tile, so its wrap seam is invisible in the noise floor.
  const base = 74 * rubber * shoulder + grain;
  return [base, base * 1.01, base * 1.05];
});

/** The run-off: the same asphalt, laid down lighter and dustier, and coarser. */
const apron = rgbaTexture(128, (u, v) => {
  const grain = (noise(Math.floor(u * 128), Math.floor(v * 128), 29) - 0.5) * 34;
  const base = 116 + grain;
  return [base, base * 0.99, base * 0.96];
});

/** Grass: two greens mottled over a slow noise, so a hillside is not one flat colour. */
const turf = rgbaTexture(128, (u, v) => {
  const coarse = noise(Math.floor(u * 9), Math.floor(v * 9), 5);
  const fine = (noise(Math.floor(u * 128), Math.floor(v * 128), 7) - 0.5) * 20;
  const base = 0.7 + coarse * 0.5;
  return [52 * base + fine, 92 * base + fine * 1.4, 46 * base + fine];
});

/** Red and white, one stripe per 1.2 m of kerb. Two texels wide, so it tiles in both axes. */
const kerbStripe = rgbaTexture(2, (u) => (u < 0.5 ? [216, 58, 48] : [242, 240, 230]));

/** Black and white, a 4x2 checker. The one transverse mark the road is meant to carry. */
const checker = rgbaTexture(8, (u, v) => {
  const on = (Math.floor(u * 4) + Math.floor(v * 2)) % 2 === 0;
  return on ? [235, 233, 224] : [18, 18, 20];
});

/** A faint cast-concrete grain as a tangent-space normal map, tiling every metre. */
function grainNormalTexture(size = 128): DataTexture {
  const cells = [8, 32];
  const lattice = cells.map((count) => {
    const values = new Float32Array(count * count);
    for (let index = 0; index < values.length; index += 1)
      values[index] = noise(index, count, count);
    return { count, values };
  });
  const height = (x: number, y: number): number => {
    let total = 0;
    for (const [octave, { count, values }] of lattice.entries()) {
      const u = (x / size) * count;
      const v = (y / size) * count;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number): number =>
        values[(((j % count) + count) % count) * count + (((i % count) + count) % count)] ?? 0;
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      total += (top + (bottom - top) * sy) * (octave === 0 ? 1 : 0.5);
    }
    return total;
  };
  const data = new Uint8Array(size * size * 4);
  const normal = new Vector3();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      normal.set(-dx * 4, -dy * 4, 1).normalize();
      const at = (y * size + x) * 4;
      data[at] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[at + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[at + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[at + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const grain = grainNormalTexture();

/**
 * Rewrites a geometry's UVs as world metres, projected along each face's dominant axis.
 * Call it after the geometry is translated into place (merged geometry included).
 */
export function worldGridUVs<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  const axis = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    axis.fromBufferAttribute(normal, index);
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const ax = Math.abs(axis.x);
    const ay = Math.abs(axis.y);
    const az = Math.abs(axis.z);
    const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return geometry;
}

export function createMaterials() {
  return {
    /** Boost chevrons and the start lights' housing. */
    boost: toon(palette.accent, 0.4),
    /** Painted white: the edge lines, the pit-lane line, the grandstand seats. */
    line: new MeshStandardMaterial({ color: 0xf1efe6, roughness: 0.7, metalness: 0 }),
    /** The kerb's red stripe. */
    kerbAlt: toon(0xd8453c, 0.5),
    /** The kerb's white stripe, and the one place the tarmac is allowed to be bright. */
    curb: toon(0xf2f0e6, 0.5),
    /** The finish line and the grid-slot marks: the one transverse pattern the road carries. */
    checker: new MeshStandardMaterial({ map: checker, roughness: 0.75, metalness: 0 }),
    /** Red and white, striped by its own texture, so the whole circuit's kerbing is one draw. */
    kerb: new MeshStandardMaterial({
      map: kerbStripe,
      normalMap: grain,
      normalScale: new Vector2(0.1, 0.1),
      roughness: 0.62,
      metalness: 0.02,
    }),
    /** The infield and everything beyond the run-off. */
    grass: new MeshStandardMaterial({
      map: turf,
      normalMap: grain,
      normalScale: new Vector2(0.35, 0.35),
      roughness: 0.95,
      metalness: 0,
    }),
    /** The paved run-off past the white line, and the pit lane. */
    runoff: new MeshStandardMaterial({
      map: apron,
      normalMap: grain,
      normalScale: new Vector2(0.16, 0.16),
      roughness: 0.88,
      metalness: 0.03,
    }),
    /** Grandstands, hoardings, gantries, garages, marshal posts. */
    structure: new MeshStandardMaterial({
      map: apron,
      normalMap: grain,
      normalScale: new Vector2(0.18, 0.18),
      color: 0x9aa0a6,
      roughness: 0.72,
      metalness: 0.05,
    }),
    /** Armco and the pit wall: galvanised steel, so they catch the sun and read as metal. */
    armco: new MeshStandardMaterial({
      color: 0xb4bcc4,
      metalness: 0.72,
      roughness: 0.42,
    }),
    road: new MeshStandardMaterial({
      color: 0x4a4a4a,
      roughness: 0.86,
      metalness: 0.04,
    }),
    shadow: new MeshStandardMaterial({ color: 0x4a4f55, roughness: 1 }),
    tire: new MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.94 }),

    /** The car. `body` is the one a game is most likely to change. */
    body: new MeshStandardMaterial({ color: 0xd93a3a, metalness: 0.18, roughness: 0.3 }),
    /** Kept as an alias so a game that already referred to the old slot still compiles. */
    vehicle: new MeshStandardMaterial({ color: 0xd93a3a, metalness: 0.18, roughness: 0.3 }),
    rivalBody: new MeshStandardMaterial({ color: palette.accent, metalness: 0.18, roughness: 0.3 }),
    glass: new MeshStandardMaterial({
      color: 0x3f5a70,
      metalness: 0.55,
      roughness: 0.1,
    }),
    // Not black. At 0x23262b every aero part on the car went to the same void and the tail read as a
    // hole; a lit dark grey still says "carbon" and keeps its own form.
    carbon: new MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.24, roughness: 0.46 }),
    wing: new MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.3, roughness: 0.4 }),
    alloy: new MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.86, roughness: 0.26 }),
    livery: new MeshStandardMaterial({ color: 0xf6f3ea, metalness: 0.05, roughness: 0.42 }),
    /** A shade darker than the body, so the arch lip is a line and not more bodywork. */
    archLip: new MeshStandardMaterial({ color: 0x7d2323, metalness: 0.3, roughness: 0.4 }),
    /** Spoke gaps: what the eye reads as the hole between spokes. */
    hubDark: new MeshStandardMaterial({ color: 0x30343a, metalness: 0.5, roughness: 0.4 }),
    headlamp: new MeshStandardMaterial({
      color: 0xfff6de,
      emissive: 0xfff0c8,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
    // Dim on purpose. At 2.2 the bar plus the bloom stage flared over the whole tail and the car's
    // rear became one orange smear — the emissive was brighter than the sun.
    taillamp: new MeshStandardMaterial({
      color: 0xd93a34,
      emissive: 0xff2a1c,
      emissiveIntensity: 0.75,
      roughness: 0.34,
    }),

    /** Trackside furniture that is instanced, so it takes a flat value rather than a mapped grid. */
    crowd: toon(0x6f7681, 0.9),
    trunk: toon(0x5b4a3c, 0.9),
    canopy: toon(0x3f6a45, 0.92),
    /** The hills past the treeline. */
    distant: toon(0x6d7a80, 0.98),
    hoardingBoard: toon(palette.accent, 0.6),
  };
}
