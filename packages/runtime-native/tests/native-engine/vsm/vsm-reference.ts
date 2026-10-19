/**
 * Records the virtual-shadow page logic's answers as a C++ table the native test replays (PRD-524
 * phase 1). Two scenarios drive the real module from packages/core/src:
 *
 *   (a) a camera walking over a clipmap with a deterministic receiver-demand feedback buffer per
 *       frame, recording the requested page set, every allocation, every eviction and the pool
 *       state after each frame;
 *   (b) casters whose bounds move across pages, recording exactly which page keys each move
 *       invalidates.
 *
 * Every double is recorded as its binary64 bit pattern, so the native comparison is exact. The
 * page-key parser and `projectBounds` are recorded too, so the whole exported CPU surface is tied
 * to the reference.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/vsm/vsm-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DirectionalClipmap,
  type IBoundsLike,
  type IVector3Like,
  PhysicalPagePool,
  ReceiverDemandPass,
  ShadowInvalidationTracker,
  parsePageKey,
  projectBounds,
} from "../../../../core/src/render/virtual-shadow-pages.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "vsm_reference.inc");

const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const bits = (x: number) => `0x${f64(x).toString(16).padStart(16, "0")}ull`;
const keyLiteral = (key: string | null) => (key === null ? "nullptr" : `"${key}"`);

interface IPagesFrame {
  camera: IVector3Like;
  receiverPoints: IVector3Like[];
  visibleBounds: IBoundsLike[];
}

const pagesDirection: IVector3Like = { x: 0, y: 1, z: 0 };
const pagesExtents = [8, 16, 32];
const pagesPerAxis = 4;
const pagesGuardBand = 1;
// Larger than the coarsest pinned window (pagesPerAxis² = 16), so non-pinned receiver pages get
// slots and later frames have several evictable pages to choose between: LRU order matters.
const pagesCapacity = 48;

const pagesFrames: IPagesFrame[] = [
  {
    camera: { x: 0.2, y: 2, z: -0.2 },
    receiverPoints: [
      { x: 0.1, y: 0, z: -0.1 },
      { x: 2.5, y: 0, z: 2.5 },
    ],
    visibleBounds: [{ min: { x: 6, y: 2, z: -2 }, max: { x: 9, y: 6, z: 2 } }],
  },
  {
    camera: { x: 4.3, y: 2, z: -4.3 },
    receiverPoints: [
      { x: 4.2, y: 0, z: -4.2 },
      { x: 1, y: 0, z: 1 },
    ],
    visibleBounds: [{ min: { x: 2, y: 1, z: -1 }, max: { x: 5, y: 4, z: 1 } }],
  },
  {
    camera: { x: 8.1, y: 2, z: -8.1 },
    receiverPoints: [
      { x: 8, y: 0, z: -8 },
      { x: 5, y: 0, z: 5 },
    ],
    visibleBounds: [{ min: { x: 10, y: 1, z: -1 }, max: { x: 13, y: 4, z: 1 } }],
  },
  {
    camera: { x: 12.4, y: 2, z: -12.4 },
    receiverPoints: [{ x: 12, y: 0, z: -12 }],
    visibleBounds: [],
  },
  {
    camera: { x: 16.2, y: 2, z: -16.2 },
    receiverPoints: [
      { x: 16, y: 0, z: -16 },
      { x: 20, y: 0, z: 20 },
    ],
    visibleBounds: [{ min: { x: 18, y: 1, z: -1 }, max: { x: 21, y: 4, z: 1 } }],
  },
  {
    camera: { x: 20.5, y: 2, z: -20.5 },
    receiverPoints: [{ x: 20, y: 0, z: -20 }],
    visibleBounds: [{ min: { x: 14, y: 1, z: -1 }, max: { x: 17, y: 4, z: 1 } }],
  },
];

interface INodeRecord {
  spec: IPagesFrame;
  requests: ReturnType<ReceiverDemandPass["collect"]>;
  allocations: {
    reused: boolean;
    overflow: boolean;
    slot: number;
    hasEvicted: boolean;
    evictedKey: string | null;
  }[];
  poolEntries: ReturnType<PhysicalPagePool["entries"]>;
  evictions: number;
  overflow: number;
  size: number;
}

function recordPages(): INodeRecord[] {
  const clipmap = new DirectionalClipmap({
    direction: pagesDirection,
    clipExtents: pagesExtents,
    pagesPerAxis,
  });
  const pool = new PhysicalPagePool(pagesCapacity);
  const pass = new ReceiverDemandPass({ guardBand: pagesGuardBand });
  return pagesFrames.map((spec, frame) => {
    clipmap.updateCenter(spec.camera);
    const requests = pass.collect({
      cameraPosition: spec.camera,
      receiverPoints: spec.receiverPoints,
      visibleBounds: spec.visibleBounds,
      clipmap,
    });
    const protectedKeys = new Set(requests.map((request) => request.key));
    const allocations = requests.map((request) => {
      const allocation = pool.allocate(request.key, {
        frame,
        pinned: request.pinned,
        protectedKeys,
      });
      if (allocation === null)
        return { reused: false, overflow: true, slot: -1, hasEvicted: false, evictedKey: null };
      return {
        reused: allocation.reused,
        overflow: false,
        slot: allocation.entry.slot,
        hasEvicted: allocation.evictedKey !== null,
        evictedKey: allocation.evictedKey,
      };
    });
    return {
      spec,
      requests,
      allocations,
      // Snapshot by value: `entries()` returns the live entries, which later frames mutate.
      poolEntries: pool.entries().map((entry) => ({ ...entry })),
      evictions: pool.evictions,
      overflow: pool.overflow,
      size: pool.size,
    };
  });
}

const bounds = (minX: number, maxX: number): IBoundsLike => ({
  min: { x: minX, y: 0, z: -0.8 },
  max: { x: maxX, y: 2, z: -0.2 },
});

const invalidationMoves: { id: string; op: "update" | "remove"; bounds: IBoundsLike }[] = [
  { id: "crate", op: "update", bounds: bounds(0.2, 0.8) },
  { id: "crate", op: "update", bounds: bounds(4.2, 4.8) },
  { id: "barrel", op: "update", bounds: bounds(8.2, 8.8) },
  { id: "crate", op: "remove", bounds: bounds(4.2, 4.8) },
  { id: "barrel", op: "update", bounds: bounds(8.2, 8.8) },
  { id: "barrel", op: "update", bounds: bounds(8.2, 20.8) },
];

interface IMoveRecord {
  id: string;
  op: "update" | "remove";
  bounds: IBoundsLike;
  changed: boolean;
  invalidated: string[];
  trackedCount: number;
}

function recordInvalidation(): { moves: IMoveRecord[]; clipmap: DirectionalClipmap } {
  const clipmap = new DirectionalClipmap({
    direction: { x: 0, y: 1, z: 0 },
    clipExtents: [8, 16, 32],
    pagesPerAxis: 4,
  });
  const tracker = new ShadowInvalidationTracker(clipmap);
  const moves = invalidationMoves.map((move) => {
    const changed =
      move.op === "remove" ? tracker.remove(move.id) : tracker.update(move.id, move.bounds);
    const invalidated = [...tracker.consumeInvalidatedKeys()].sort();
    return { ...move, changed, invalidated, trackedCount: tracker.trackedCount };
  });
  return { moves, clipmap };
}

const keyCases = ["3:-17:42", "0:0:0", "-1:2:-3", "1:2", "a:b:c"].map((key) => {
  try {
    const parsed = parsePageKey(key);
    return { key, valid: true, level: parsed.level, x: parsed.x, y: parsed.y };
  } catch {
    return { key, valid: false, level: 0, x: 0, y: 0 };
  }
});

const pages = recordPages();
const invalidation = recordInvalidation();
const projectBoundsCases = [bounds(0.2, 0.8), bounds(8.2, 8.8)].flatMap((box) =>
  [invalidation.clipmap.basisU, invalidation.clipmap.basisV, invalidation.clipmap.basisW].map(
    (axis) => ({ box, axis, range: projectBounds(box, axis) }),
  ),
);

const lines: string[] = [
  "// Generated by packages/runtime-native/tests/native-engine/vsm/vsm-reference.ts from",
  "// packages/core/src/render/virtual-shadow-pages.ts. Do not edit: rerun the generator. Doubles",
  "// are binary64 bit patterns; counts are decimal integers.",
  "",
  "struct RefVec { uint64_t x, y, z; };",
  "struct RefBounds { uint64_t minX, minY, minZ, maxX, maxY, maxZ; };",
  "struct RefRequest { const char* key; int32_t level; int32_t x; int32_t y; bool pinned; uint64_t priority; };",
  "struct RefAllocation { bool reused; bool overflow; int32_t slot; bool hasEvicted; const char* evictedKey; };",
  "struct RefPoolEntry { const char* key; int32_t slot; bool pinned; bool dirty; uint64_t generation; uint64_t lastUsedFrame; };",
  "struct RefPagesFrame { uint64_t frame; uint64_t cameraX, cameraY, cameraZ; const RefVec* receiverPoints; std::size_t receiverCount; const RefBounds* visibleBounds; std::size_t visibleBoundCount; const RefRequest* requests; std::size_t requestCount; const RefAllocation* allocations; std::size_t allocationCount; const RefPoolEntry* poolEntries; std::size_t poolEntryCount; uint32_t evictions; uint32_t overflow; uint32_t poolSize; };",
  "struct RefKeyCase { const char* key; bool valid; int32_t level; int32_t x; int32_t y; };",
  "struct RefRange { uint64_t low, high; };",
  "struct RefProjectBounds { RefBounds bounds; uint64_t axisX, axisY, axisZ; RefRange range; };",
  "struct RefInvMove { const char* id; int32_t op; RefBounds bounds; bool changed; const char* const* invalidated; std::size_t invalidatedCount; uint32_t trackedCount; };",
  "",
  `static const uint64_t kPagesDirection[3] = {${bits(pagesDirection.x)}, ${bits(pagesDirection.y)}, ${bits(pagesDirection.z)}};`,
  `static const uint64_t kPagesExtents[3] = {${pagesExtents.map(bits).join(", ")}};`,
  `static const uint64_t kPagesGuards[1] = {${bits(0.9)}};`,
  `static const uint64_t kPagesSteps[1] = {${bits(0.125)}};`,
  `static const int32_t kPagesPerAxis = ${pagesPerAxis};`,
  `static const int32_t kPagesCapacity = ${pagesCapacity};`,
  `static const int32_t kPagesGuardBand = ${pagesGuardBand};`,
  "",
];

const boundLiteral = (box: IBoundsLike) =>
  `{${bits(box.min.x)}, ${bits(box.min.y)}, ${bits(box.min.z)}, ${bits(box.max.x)}, ${bits(box.max.y)}, ${bits(box.max.z)}}`;

for (const [index, record] of pages.entries()) {
  if (record.spec.receiverPoints.length > 0) {
    lines.push(`static const RefVec kPagesReceiver${index}[] = {`);
    for (const point of record.spec.receiverPoints)
      lines.push(`    {${bits(point.x)}, ${bits(point.y)}, ${bits(point.z)}},`);
    lines.push("};", "");
  }
  if (record.spec.visibleBounds.length > 0) {
    lines.push(`static const RefBounds kPagesVisible${index}[] = {`);
    for (const box of record.spec.visibleBounds) lines.push(`    ${boundLiteral(box)},`);
    lines.push("};", "");
  }
  lines.push(`static const RefRequest kPagesRequests${index}[] = {`);
  for (const request of record.requests)
    lines.push(
      `    {${keyLiteral(request.key)}, ${request.level}, ${request.x}, ${request.y}, ${request.pinned}, ${bits(request.priority)}},`,
    );
  lines.push("};", "");
  lines.push(`static const RefAllocation kPagesAllocations${index}[] = {`);
  for (const allocation of record.allocations)
    lines.push(
      `    {${allocation.reused}, ${allocation.overflow}, ${allocation.slot}, ${allocation.hasEvicted}, ${keyLiteral(allocation.evictedKey)}},`,
    );
  lines.push("};", "");
  lines.push(`static const RefPoolEntry kPagesPool${index}[] = {`);
  for (const entry of record.poolEntries)
    lines.push(
      `    {${keyLiteral(entry.key)}, ${entry.slot}, ${entry.pinned}, ${entry.dirty}, ${entry.generation}ull, ${bits(entry.lastUsedFrame)}},`,
    );
  lines.push("};", "");
}

lines.push("static const RefPagesFrame kPagesFrames[] = {");
for (const [index, record] of pages.entries()) {
  const receivers = record.spec.receiverPoints.length > 0 ? `kPagesReceiver${index}` : "nullptr";
  const visible = record.spec.visibleBounds.length > 0 ? `kPagesVisible${index}` : "nullptr";
  lines.push(
    `    {${bits(index)}, ${bits(record.spec.camera.x)}, ${bits(record.spec.camera.y)}, ${bits(record.spec.camera.z)}, ` +
      `${receivers}, ${record.spec.receiverPoints.length}, ${visible}, ${record.spec.visibleBounds.length}, ` +
      `kPagesRequests${index}, ${record.requests.length}, kPagesAllocations${index}, ${record.allocations.length}, ` +
      `kPagesPool${index}, ${record.poolEntries.length}, ${record.evictions}, ${record.overflow}, ${record.size}},`,
  );
}
lines.push("};", "");

lines.push("static const RefKeyCase kPageKeyCases[] = {");
for (const keyCase of keyCases)
  lines.push(
    `    {${keyLiteral(keyCase.key)}, ${keyCase.valid}, ${keyCase.level}, ${keyCase.x}, ${keyCase.y}},`,
  );
lines.push("};", "");

lines.push("static const RefProjectBounds kProjectBoundsCases[] = {");
for (const projectCase of projectBoundsCases)
  lines.push(
    `    {${boundLiteral(projectCase.box)}, ${bits(projectCase.axis.x)}, ${bits(projectCase.axis.y)}, ${bits(projectCase.axis.z)}, {${bits(projectCase.range.low)}, ${bits(projectCase.range.high)}}},`,
  );
lines.push("};", "");

for (const [index, move] of invalidation.moves.entries()) {
  lines.push(`static const char* const kInvKeys${index}[] = {`);
  for (const key of move.invalidated) lines.push(`    ${keyLiteral(key)},`);
  lines.push("};", "");
}

lines.push("static const RefInvMove kInvMoves[] = {");
for (const [index, move] of invalidation.moves.entries()) {
  lines.push(
    `    {${keyLiteral(move.id)}, ${move.op === "remove" ? 1 : 0}, ${boundLiteral(move.bounds)}, ${move.changed}, ` +
      `kInvKeys${index}, ${move.invalidated.length}, ${move.trackedCount}},`,
  );
}
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      "TN_FIXTURE_STALE: vsm_reference.inc is not what virtual-shadow-pages.ts produces",
    );
    process.exit(1);
  }
  console.log("current: vsm_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
