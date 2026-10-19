import { ANIMAL_ARRAYS, ANIMAL_DONOR_REVISION, bakeIntegrity } from "../src/format.js";
import type { AnimalArrayKey } from "../src/format.js";

// Synthetic triangle fixture tests the PANM trust boundary, never animal/render qualification.
export function animalFixture() {
  return {
    version: 1,
    species: "wolf",
    seed: 1,
    quality: "crowd",
    nV: 3,
    bones: [{ name: "root", parent: null, headJ: "head", tailJ: "tail" }],
    joints: { head: [0, 0, 0], tail: [0, 1, 0] },
    refJoints: { head: [0, 0, 0], tail: [0, 1, 0] },
    params: { size: 1 },
    threenative: {
      donorRevision: ANIMAL_DONOR_REVISION,
      adapterVersion: 1,
      buildRuntime: "node-v20.19.6",
      cacheKey: "0".repeat(64),
      integrity: "00000000",
    },
    pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    index: new Uint32Array([0, 1, 2]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    comb: new Float32Array(9),
    tint: new Float32Array(12),
    coat: new Float32Array(12),
    pat: new Float32Array(12),
    surf: new Float32Array(12),
  };
}

// Test encoder follows donor src/bake.js PANM v1 layout. MIT notice ships with this package.
export function encodeFixture(
  data = animalFixture(),
  mutateHeader: (header: Record<string, unknown>) => void = () => {},
): ArrayBuffer {
  const header: Record<string, unknown> = Object.fromEntries(
    Object.entries(data).filter(([key]) => !Object.hasOwn(ANIMAL_ARRAYS, key)),
  );
  let offset = 0;
  const sections = (Object.keys(ANIMAL_ARRAYS) as AnimalArrayKey[]).map((key) => {
    const array = data[key];
    const section = { key, type: array.constructor.name, length: array.length, offset };
    offset += Math.ceil(array.byteLength / 8) * 8;
    return section;
  });
  header.arrays = sections;
  mutateHeader(header);
  (header.threenative as Record<string, unknown>).integrity = "00000000";
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerBytes = Math.ceil(json.length / 8) * 8;
  const start = Math.ceil((12 + headerBytes) / 8) * 8;
  const buffer = new ArrayBuffer(start + offset);
  const bytes = new Uint8Array(buffer);
  bytes.set([80, 65, 78, 77]);
  const view = new DataView(buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, headerBytes, true);
  bytes.fill(32, 12, 12 + headerBytes);
  bytes.set(json, 12);
  let written = 0;
  for (const key of Object.keys(ANIMAL_ARRAYS) as AnimalArrayKey[]) {
    const array = data[key];
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), start + written);
    written += Math.ceil(array.byteLength / 8) * 8;
  }
  (header.threenative as Record<string, unknown>).integrity = bakeIntegrity(buffer);
  const finalHeader = new TextEncoder().encode(JSON.stringify(header));
  if (finalHeader.byteLength > headerBytes) throw new Error("Test integrity changed header extent");
  bytes.set(finalHeader, 12);
  return buffer;
}
