// A hand-built GLB: two cube meshes under scaled nodes (a trunk and a crown, in feet), plus an
// imported camera and light that must stay inactive. Generated here, so there is no third-party art.

const FACES = [
  [
    [1, 0, 0],
    [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  ],
  [
    [-1, 0, 0],
    [
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, -1],
    ],
  ],
  [
    [0, 1, 0],
    [
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
  ],
  [
    [0, -1, 0],
    [
      [-1, -1, 1],
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
    ],
  ],
  [
    [0, 0, 1],
    [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  ],
  [
    [0, 0, -1],
    [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
  ],
];

const ATTRIBUTES = ["POSITION", "NORMAL", "TEXCOORD_0"];
const LIGHTS = "KHR_lights_punctual";

function pad(bytes, fill) {
  const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
  out.set(bytes);
  return out;
}

/**
 * @param {object} [options]
 * @param {number} [options.unit] metres per model unit; the cube is 1 unit across before node scale
 * @param {boolean} [options.external] reference a buffer file that is not embedded
 * @param {boolean} [options.nan] put a NaN in the first vertex
 * @param {boolean} [options.extras] add an imported camera and light node
 */
export function buildGlb({ unit = 1, external = false, nan = false, extras = true } = {}) {
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);
  const uvs = new Float32Array(24 * 2);
  FACES.forEach(([normal, corners], face) => {
    corners.forEach((corner, i) => {
      positions.set(
        corner.map((v) => (v * unit) / 2),
        (face * 4 + i) * 3,
      );
      normals.set(normal, (face * 4 + i) * 3);
      uvs.set([i % 3 === 0 ? 0 : 1, i < 2 ? 0 : 1], (face * 4 + i) * 2);
    });
    indices.set(
      [0, 1, 2, 0, 2, 3].map((v) => face * 4 + v),
      face * 6,
    );
  });
  if (nan) positions[0] = Number.NaN;
  const bin = pad(
    new Uint8Array([
      ...new Uint8Array(positions.buffer),
      ...new Uint8Array(normals.buffer),
      ...new Uint8Array(indices.buffer),
      ...new Uint8Array(uvs.buffer),
    ]),
    0,
  );
  const gltf = {
    asset: { version: "2.0", generator: "strata-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "tree", children: [1, 2, ...(extras ? [3, 4] : [])] },
      { name: "trunk", mesh: 0, translation: [0, 0.6 * unit, 0], scale: [0.3, 1.2, 0.3] },
      { name: "crown", mesh: 1, translation: [0, 1.8 * unit, 0], scale: [1.2, 1.2, 1.2] },
      ...(extras
        ? [
            { name: "imported-camera", camera: 0, translation: [0, 2, 8] },
            { name: "imported-light", extensions: { [LIGHTS]: { light: 0 } } },
          ]
        : []),
    ],
    meshes: [
      {
        name: "trunk",
        primitives: [
          {
            attributes: { [ATTRIBUTES[0]]: 0, [ATTRIBUTES[1]]: 1, [ATTRIBUTES[2]]: 3 },
            indices: 2,
            material: 0,
          },
        ],
      },
      {
        name: "crown",
        primitives: [
          {
            attributes: { [ATTRIBUTES[0]]: 0, [ATTRIBUTES[1]]: 1, [ATTRIBUTES[2]]: 3 },
            indices: 2,
            material: 1,
          },
        ],
      },
    ],
    materials: [
      {
        name: "bark",
        pbrMetallicRoughness: {
          baseColorFactor: [0.35, 0.2, 0.1, 1],
          roughnessFactor: 0.9,
          metallicFactor: 0,
        },
      },
      {
        name: "leaf",
        pbrMetallicRoughness: {
          baseColorFactor: [0.1, 0.5, 0.15, 1],
          roughnessFactor: 0.7,
          metallicFactor: 0,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: "VEC3",
        min: [-0.5 * unit, -0.5 * unit, -0.5 * unit],
        max: [0.5 * unit, 0.5 * unit, 0.5 * unit],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
      { bufferView: 3, componentType: 5126, count: 24, type: "VEC2" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 288 },
      { buffer: 0, byteOffset: 288, byteLength: 288 },
      { buffer: 0, byteOffset: 576, byteLength: 72 },
      { buffer: 0, byteOffset: 648, byteLength: 192 },
    ],
    buffers: [
      { byteLength: bin.length },
      ...(external ? [{ uri: "missing-textures.bin", byteLength: 8 }] : []),
    ],
    ...(extras
      ? {
          cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 0.1 } }],
          extensionsUsed: [LIGHTS],
          extensions: { [LIGHTS]: { lights: [{ type: "point", intensity: 500 }] } },
        }
      : {}),
  };
  const json = pad(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  view.setUint32(20 + json.length, bin.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}
