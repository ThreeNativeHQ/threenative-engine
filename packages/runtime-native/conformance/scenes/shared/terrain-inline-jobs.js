import { MeshStandardMaterial } from "three";
import { WorldCells } from "../../../../core/src/world-cells.ts";
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

/**
 * One empty-run cell: no asset and no chunk, so residency alone answers the spawn region.
 *
 * The decoded manifest and placements mean the real `WorldCells` needs no fetch, no GLTF and no
 * browser global, which is the only reason this row can assert the gate on the native host too.
 */
const READINESS_MANIFEST = {
  version: 1,
  extent: { minX: 0, minZ: 0, sizeX: 64, sizeZ: 64 },
  cellSize: 64,
  terrain: { heightmap: "unused.u16", columns: 5, rows: 5, spacing: 16, heightMin: 0, heightMax: 1 },
  placements: "unused.bin",
  assets: {},
  cells: [{ x: 0, z: 0, runs: [] }],
};

/** A follow point far outside the one-cell ring, so the cell stays unadmitted until the walk. */
const AWAY = 9_000_000;

/**
 * Each `WorldCells.load` this row makes: caller surface, no terrain, no network.
 *
 * The surface is the caller's, not the world's: `WorldCells.dispose` releases only what it built,
 * so this returns the surface beside the world and every caller disposes it. A rejected load hands
 * back no world to own the surface, so it disposes the surface here.
 */
async function readinessWorld(follow) {
  const surface = new THREE.MeshBasicMaterial();
  try {
    const world = await WorldCells.load({
      url: "world.json",
      surface,
      follow,
      ring: 0,
      terrain: false,
      data: { manifest: READINESS_MANIFEST, placements: new ArrayBuffer(0) },
      budgets: { bytes: 64, instances: 1, residentCells: 1 },
    });
    return { world, surface };
  } catch (error) {
    surface.dispose();
    throw error;
  }
}

/** Await a rejection whose message names the expected fragment, and fail closed on a resolve. */
async function expectRejection(promise, fragment) {
  try {
    await promise;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    assertCondition(
      message.includes(fragment),
      `terrain-inline-jobs: unexpected spawn rejection '${message}'`,
    );
    return;
  }
  throw new Error(`terrain-inline-jobs: expected a spawn rejection naming '${fragment}'`);
}

/**
 * Lifecycle assertions for `WorldCells.whenSpawnReady` on this host.
 *
 * The core spec pins the gate in Node with a mocked loader. This drives the real class: a region
 * outside the ring pends, the update that admits it settles the waiter for its snapshot, a settled
 * region answers the next call once, disposal rejects a waiting world, and an unadmitted region
 * meets its finite deadline. The marker prints only after every assertion above it holds.
 */
export async function assertSpawnReadiness() {
  // A pending region: not ready at arm time, resolved by the update that admits it.
  const follow = { position: { x: AWAY, y: 0, z: AWAY } };
  const { world, surface } = await readinessWorld(follow);
  try {
    const spawn = { x: 32, z: 32 };
    const before = world.readinessAt(spawn);
    assertCondition(
      before.ready === false && before.requiredCells === 1 && before.loadedCells === 0,
      "terrain-inline-jobs: an unadmitted spawn region must not be ready",
    );
    const pending = world.whenSpawnReady(spawn, 0, 5000);
    let settled;
    let failure;
    pending.then(
      (readiness) => {
        settled = readiness;
      },
      (error) => {
        failure = error;
      },
    );
    // Mutated after the call: the waiter must keep the coordinates it armed with.
    spawn.x = AWAY;
    world.update();
    await Promise.resolve();
    assertCondition(
      settled === undefined && failure === undefined,
      "terrain-inline-jobs: an unadmitted region must keep its waiter pending",
    );
    // Move the follow point into the ring, then drive updates and microtasks until it settles.
    follow.position.x = 32;
    follow.position.z = 32;
    for (let frame = 0; frame < 64 && settled === undefined && failure === undefined; frame += 1) {
      world.update();
      await Promise.resolve();
    }
    assertCondition(
      failure === undefined,
      `terrain-inline-jobs: whenSpawnReady rejected: ${String(failure)}`,
    );
    assertCondition(
      settled !== undefined &&
        settled.ready === true &&
        settled.loadedCells === 1 &&
        settled.requiredCells === 1 &&
        settled.failures === 0,
      "terrain-inline-jobs: the admitted spawn region did not settle ready",
    );
    // One-shot: the settled region answers the next call immediately, with no further update.
    const again = await world.whenSpawnReady({ x: 32, z: 32 }, 0, 5000);
    assertCondition(
      again.ready === true && again.loadedCells === 1,
      "terrain-inline-jobs: a ready region must answer immediately",
    );
  } finally {
    world.dispose();
    surface.dispose();
  }

  // Disposal rejects a waiting world instead of leaving a game awaiting its gate.
  const doomedFollow = { position: { x: AWAY, y: 0, z: AWAY } };
  const { world: doomed, surface: doomedSurface } = await readinessWorld(doomedFollow);
  try {
    const pending = doomed.whenSpawnReady({ x: 32, z: 32 }, 0, 5000);
    doomed.update();
    await Promise.resolve();
    doomed.dispose();
    await expectRejection(pending, "WorldCells spawn cancelled");
  } finally {
    doomed.dispose();
    doomedSurface.dispose();
  }

  // An unadmitted region meets its finite deadline, and the region stays unready.
  const timedFollow = { position: { x: AWAY, y: 0, z: AWAY } };
  const { world: timed, surface: timedSurface } = await readinessWorld(timedFollow);
  try {
    await expectRejection(
      timed.whenSpawnReady({ x: 32, z: 32 }, 0, 25),
      "WorldCells spawn exceeded 25 ms",
    );
    assertCondition(
      timed.readinessAt({ x: 32, z: 32 }).ready === false,
      "terrain-inline-jobs: a timed-out region must stay unready",
    );
  } finally {
    timed.dispose();
    timedSurface.dispose();
  }

  console.info("TN_WORLD_SPAWN_READINESS pending=resolve dispose=reject timeout=25ms");
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
  // The spawn gate the streamed terrain games repeat, proven on the real class before the frame.
  await assertSpawnReadiness();
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
