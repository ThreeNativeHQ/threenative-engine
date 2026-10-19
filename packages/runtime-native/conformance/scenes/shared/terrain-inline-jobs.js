import { MeshStandardMaterial } from "three";
import { TerrainTiles } from "../../../../core/src/world-tiles.ts";
import { assertCondition, startVisualScene, THREE } from "./scene-support.js";

/**
 * Hosts without workers run the terrain merge and seam jobs inline.
 *
 * A workerless host is the missing half of the worker rows: the block merge and the seam bridge
 * strip move off the main thread where a worker exists, and a host with none runs the same
 * functions on the calling thread. The settled bytes must not change with the transport, so this
 * row settles a ring inline, hashes every block and bridge the way a renderer reads it, and
 * requires that fingerprint to equal the node inline path's. The hash is a fixed constant rather
 * than one host's second run: a native inline settlement that merely agreed with itself would
 * prove nothing.
 */

/** Off the world origin, so a block's own transform cannot hide a wrong merge. */
const ISLAND = { x: 48, z: 48 };

/** The node inline path's fingerprint, pinned from `settleInlineTerrainHash()` on this source. */
const EXPECTED_HASH = "d138e335";

/**
 * Integer arithmetic only. `Math.sin`/`Math.cos` are allowed to differ by an ulp between V8 builds,
 * and one ulp here moves a vertex and changes every hash it feeds, so the field stays bit-exact.
 */
const sampleHeight = (x, z) =>
  ((x * 0.37 + z * 0.11) % 7) * 0.6 + ((z * 0.53 - x * 0.19) % 5) * 0.9 + ((x * 0.07 + z * 0.13) % 3) * 1.4;

/** Two LOD tiers, so the ring has neighbours to reconcile and a seam strip to build. */
function ring() {
  return new TerrainTiles({
    lodDistances: [8],
    lodFactors: [1, 2],
    mergeTiles: true,
    residentByteBudget: 64_000_000,
    residentTileBudget: 64,
    sampleHeight,
    streamRadius: 1,
    surface: new MeshStandardMaterial({ color: 0x6f8f5f, metalness: 0, roughness: 1 }),
    tileResolution: 33,
    tileSize: 16,
  });
}

/** Settle the ring for twelve frames, the same walk the node spec makes with no worker. */
function settle(tiles) {
  for (let frame = 0; frame < 12; frame += 1) tiles.follow(ISLAND);
}

/**
 * FNV-1a, 32-bit. Small, synchronous, and identical on every V8 this row runs on: no `crypto`,
 * which the native host does not install, and no float, so the digest cannot move by an ulp.
 */
function fnv1a(hash, bytes) {
  let value = hash >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    value ^= bytes[index];
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

function u32(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function ascii(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** One geometry's bytes, as a renderer reads them: position, normal and index, no tolerance. */
function geometryChunks(geometry) {
  const chunks = [];
  for (const name of ["position", "normal"]) {
    const attribute = geometry.getAttribute(name);
    assertCondition(attribute !== undefined, `terrain-inline-jobs: geometry has no ${name}`);
    const array = attribute.array;
    chunks.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  const index = geometry.getIndex();
  assertCondition(index !== null, "terrain-inline-jobs: geometry is not indexed");
  chunks.push(new Uint8Array(index.array.buffer, index.array.byteOffset, index.array.byteLength));
  return chunks;
}

/**
 * A stable fingerprint of every settled geometry.
 *
 * Meshes are ordered by name, then by their own content hash, so an unnamed bridge cannot make the
 * result depend on scene-graph insertion order: identical content sorts together and folds the same.
 */
export function hashSettlement(tiles) {
  const parts = tiles.children
    .filter((child) => child.isMesh === true)
    .map((mesh) => {
      const chunks = geometryChunks(mesh.geometry);
      let content = 0x811c9dc5;
      let length = 0;
      for (const chunk of chunks) {
        content = fnv1a(content, chunk);
        length += chunk.length;
      }
      return { content, length, name: mesh.name };
    });
  assertCondition(parts.length > 0, "terrain-inline-jobs: the ring settled no geometry");
  parts.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.content !== right.content) return left.content - right.content;
    return left.length - right.length;
  });
  let hash = 0x811c9dc5;
  for (const part of parts) {
    hash = fnv1a(hash, ascii(part.name));
    hash = fnv1a(hash, u32(part.content));
    hash = fnv1a(hash, u32(part.length));
  }
  return hash.toString(16).padStart(8, "0");
}

function bridgeCount(tiles) {
  return tiles.children.filter(
    (child) => child.isMesh === true && !child.name.startsWith("tn-terrain-block:"),
  ).length;
}

/**
 * Settle the ring with no worker and fingerprint it.
 *
 * `Worker` is hidden for the settle, which is the box's own scenario: the host has no worker to
 * move the jobs to. The native host's real shim refuses a module source by name and falls back to
 * this same inline path, so the browser reference and the native capture run one body.
 */
export function settleInlineTerrainHash() {
  const saved = globalThis.Worker;
  globalThis.Worker = undefined;
  const tiles = ring();
  try {
    settle(tiles);
    const stat = tiles.debug().terrainTiles;
    assertCondition(stat.blocks > 0, "terrain-inline-jobs: the ring merged no blocks");
    assertCondition(tiles.stitchedEdgeCount > 0, "terrain-inline-jobs: the ring built no bridges");
    return { bridges: bridgeCount(tiles), blocks: stat.blocks, hash: hashSettlement(tiles) };
  } finally {
    tiles.dispose();
    globalThis.Worker = saved;
  }
}

export async function startScene(canvas, dimensions) {
  const settled = settleInlineTerrainHash();
  assertCondition(
    settled.hash === EXPECTED_HASH,
    `terrain-inline-jobs: inline hash ${settled.hash} != node inline hash ${EXPECTED_HASH}`,
  );
  // Named on the lane's own output, so the settled digest is readable without decoding a frame.
  console.info(
    `TN_TERRAIN_INLINE_HASH hash=${settled.hash} blocks=${settled.blocks} ` +
      `bridges=${settled.bridges} expected=${EXPECTED_HASH}`,
  );
  return startVisualScene(
    canvas,
    dimensions,
    "terrain-inline-jobs",
    ({ scene }) => {
      // The rendered ring settles the same way, so the frame a renderer draws is the bytes hashed.
      const saved = globalThis.Worker;
      globalThis.Worker = undefined;
      const tiles = ring();
      try {
        settle(tiles);
        assertCondition(
          hashSettlement(tiles) === EXPECTED_HASH,
          "terrain-inline-jobs: the rendered ring did not settle the pinned inline hash",
        );
      } finally {
        globalThis.Worker = saved;
      }
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(ISLAND.x + 30, 60, ISLAND.z + 20);
      scene.add(tiles, sun, new THREE.AmbientLight(0x9fb8ff, 0.5));
      return { detail: settled };
    },
    {
      background: 0x101823,
      camera: (size) => {
        const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 400);
        camera.position.set(ISLAND.x - 22, 26, ISLAND.z + 30);
        camera.lookAt(ISLAND.x, 0, ISLAND.z);
        return camera;
      },
    },
  );
}
