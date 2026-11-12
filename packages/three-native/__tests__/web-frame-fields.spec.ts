// The `tnw_web_frame` field table is an ABI: the facade passes a number and the host answers a
// value, so a field that moves reads one measurement as another with nothing failing. These checks
// pin the three copies that exist — the manifest, the TypeScript constant and the C++ enum — and the
// ids this ABI has already published, so a renumber has to be deliberate.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WEB_FRAME_FIELD } from "../src/generated/web-frame-fields.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "packages/three-native/api/web-frame-fields.json");
const HEADER = path.join(ROOT, "packages/runtime-native/src/engine/wasm/web_frame_fields.h");

interface IField {
  readonly id: number;
  readonly name: string;
}

function manifestFields(): readonly IField[] {
  const parsed = JSON.parse(readFileSync(MANIFEST, "utf8")) as { fields: readonly IField[] };
  return parsed.fields;
}

/** `TN_WEB_FRAME_CPU_METERS_ON` for `cpuMetersOn`, the spelling the generated header uses. */
function macro(name: string): string {
  return `TN_WEB_FRAME_${name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase()}`;
}

/**
 * Every field this ABI has published, at the id it published.
 *
 * Frozen pairs rather than a digest of the table: a digest cannot tell the one edit that is allowed
 * (append a field) from the one that is not (move it), because either needs a new value. Comparing
 * pairs names the field that moved, and a new field only adds a row.
 */
const FROZEN_FIELDS: Readonly<Record<string, number>> = {
  cpuMetersOff: -4,
  cpuMetersOn: -3,
  debugTimestampOff: -2,
  debugTimestampOn: -1,
  draws: 0,
  triangles: 1,
  pipelineCompiles: 2,
  pipelineLookups: 3,
  bindGroupsCreated: 4,
  graphKeyBuilds: 5,
  programs: 6,
  gpuMs: 7,
  gpuSamples: 8,
  gpuSourceFrame: 9,
  gpuTimerAvailable: 10,
  gpuBusy: 11,
  environmentPending: 12,
  temporalActive: 13,
  temporalFrame: 14,
  temporalHistoryValid: 15,
  temporalJitterX: 16,
  temporalJitterY: 17,
  sampleCount: 18,
  gpuSegmentShadow: 19,
  gpuSegmentScene: 20,
  gpuSegmentOther: 21,
  gpuSegmentOutput: 22,
  gpuSegmentGather: 23,
  gpuSegmentLampShadow: 24,
  lampRedraws: 25,
  lampShadowDraws: 26,
  shadowDraws: 27,
  lampMapMin: 28,
  lampMapMax: 29,
  temporalRejected: 30,
  temporalClamped: 31,
  temporalPixels: 32,
  temporalCountedFrame: 33,
  temporalUpscale: 34,
  inputWidth: 35,
  inputHeight: 36,
  temporalJitterLength: 37,
  width: 38,
  height: 39,
  keptShadowMaps: 40,
  uniformBytes: 41,
  mainRecorded: 60,
  recordCause: 61,
  auxRecorded: 62,
  recordMs: 63,
  shadowEncodeMs: 64,
  shadowRecorded: 65,
  cpuVirtualPagesMs: 66,
  cpuPlanMs: 67,
  cpuShadowBuildMs: 68,
  cpuPrepareMs: 69,
  cpuEncodeMs: 70,
  worldSubmissions: 71,
  shadowInputsReady: 72,
  cpuPostMs: 73,
  sceneMs: 74,
  hostRenderMs: 75,
  hostComputeMs: 76,
  hostSubmitMs: 77,
  stageTotalsAddress: 78,
  hostPollMs: 79,
  hostTailMs: 80,
  rendererMs: 81,
  hostDatabaseMs: 82,
  hostTargetMs: 83,
  cpuMetersActive: 84,
  shadowTriangles: 85,
  firstWorldFrameDrawn: 86,
  textureCompressionBc: 87,
  virtualShadowPendingLevels: 88,
  frameSnapshot: 89,
};

describe("the web frame field table", () => {
  it("should generate the TypeScript constant from the manifest", () => {
    const generated = Object.fromEntries(Object.entries(WEB_FRAME_FIELD));
    expect(generated).toEqual(Object.fromEntries(manifestFields().map((f) => [f.name, f.id])));
  });

  it("should generate the C++ enum from the manifest", () => {
    const header = readFileSync(HEADER, "utf8");
    const rows = [...header.matchAll(/^\s*(TN_WEB_FRAME_[A-Z0-9_]+) = (-?\d+),$/gmu)].map(
      ([, name, id]) => [name, Number(id)] as const,
    );
    expect(rows).toEqual(manifestFields().map((f) => [macro(f.name), f.id] as const));
  });

  it("should keep every published field at the id it was published with", () => {
    const moved = Object.entries(FROZEN_FIELDS).filter(
      ([name, id]) => (WEB_FRAME_FIELD as Record<string, number>)[name] !== id,
    );
    expect(
      moved.map(([name, id]) => `${name} moved from ${String(id)}`),
      "ids are frozen and append-only: restore the old id, and give a new field the next free one",
    ).toEqual([]);
  });

  it("should fit every field in the frame snapshot block", () => {
    // tnw_web_frame 89 copies every field into one block of 256 doubles (web_host.cpp frameBlock),
    // and the renderer reads a field at the block's address plus its id.
    expect(manifestFields().filter((field) => field.id >= 256)).toEqual([]);
  });

  it("should declare every published field in the manifest", () => {
    const published = new Set(manifestFields().map((field) => field.name));
    expect(Object.keys(FROZEN_FIELDS).filter((name) => !published.has(name))).toEqual([]);
  });
});
