// Builds the example's card crown: 1,200 alpha-tested quads (2,400 triangles) scattered through a
// sphere, written as a dependency-free GLB. The cook gives it a `cards` chain whose levels draw
// scaled copies of the kept cards appended after LOD0's vertices (PRD-541), which is the shape the
// desktop scenarios prove the native host draws.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CARDS = 1200;
const HALF = 0.09;

// A fixed LCG, so the file is the same bytes on every run.
let seed = 7;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const positions = new Float32Array(CARDS * 4 * 3);
const indices = new Uint32Array(CARDS * 6);
for (let card = 0; card < CARDS; card += 1) {
  let x;
  let y;
  let z;
  do {
    x = random() * 2 - 1;
    y = random() * 2 - 1;
    z = random() * 2 - 1;
  } while (x * x + y * y + z * z > 1);
  const angle = random() * Math.PI;
  const ux = Math.cos(angle) * HALF;
  const uz = Math.sin(angle) * HALF;
  const corners = [
    [x - ux, y - HALF, z - uz],
    [x + ux, y - HALF, z + uz],
    [x + ux, y + HALF, z + uz],
    [x - ux, y + HALF, z - uz],
  ];
  for (const [corner, point] of corners.entries()) positions.set(point, (card * 4 + corner) * 3);
  const a = card * 4;
  indices.set([a, a + 1, a + 2, a, a + 2, a + 3], card * 6);
}

const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], positions[vertex * 3 + axis]);
    max[axis] = Math.max(max[axis], positions[vertex * 3 + axis]);
  }
}

const pad = (buffer, fill) =>
  buffer.length % 4 === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4), fill)]);
const positionBuffer = Buffer.from(positions.buffer);
const indexBuffer = Buffer.from(indices.buffer);
const bin = pad(Buffer.concat([positionBuffer, indexBuffer]), 0);
const json = pad(
  Buffer.from(
    JSON.stringify({
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: positions.length / 3,
          max,
          min,
          type: "VEC3",
        },
        { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
      ],
      asset: { generator: "examples/auto-lod make-cards", version: "2.0" },
      bufferViews: [
        { buffer: 0, byteLength: positionBuffer.length, byteOffset: 0, target: 34962 },
        {
          buffer: 0,
          byteLength: indexBuffer.length,
          byteOffset: positionBuffer.length,
          target: 34963,
        },
      ],
      buffers: [{ byteLength: bin.length }],
      materials: [
        {
          alphaCutoff: 0.5,
          alphaMode: "MASK",
          doubleSided: true,
          name: "leaf",
          pbrMetallicRoughness: { baseColorFactor: [0.2, 0.45, 0.15, 1], metallicFactor: 0 },
        },
      ],
      meshes: [
        // biome-ignore lint/style/useNamingConvention: `POSITION` is the glTF attribute semantic, fixed by the spec.
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] },
      ],
      nodes: [{ mesh: 0 }],
      scene: 0,
      scenes: [{ nodes: [0] }],
    }),
  ),
  0x20,
);

const total = 12 + 8 + json.length + 8 + bin.length;
const glb = Buffer.alloc(total);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(total, 8);
glb.writeUInt32LE(json.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
json.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + json.length);
glb.writeUInt32LE(0x004e4942, 24 + json.length);
bin.copy(glb, 28 + json.length);
writeFileSync(resolve(here, "../assets/cards.glb"), glb);
