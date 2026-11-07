// The `tnw_web_frame` field table is an ABI: the facade passes a number and the host answers a
// value, so a field that moves reads one measurement as another with nothing failing. These checks
// pin the three copies that exist — the manifest, the TypeScript constant and the C++ enum — and
// the digest of the table itself, so a renumber has to be deliberate.
import { createHash } from "node:crypto";
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
 * The digest of the whole table. A field that moves changes it, and so does a rename; adding a
 * field at the end is the only edit that leaves the existing ids alone, which is the point.
 */
const FIELD_TABLE_DIGEST = "faae3793e5b2581b";

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

  it("should pin the field ids, so a renumbered field goes red", () => {
    const digest = createHash("sha256")
      .update(
        manifestFields()
          .map((f) => `${f.name}:${String(f.id)}`)
          .join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
    expect(
      digest,
      "a tnw_web_frame field moved: ids are frozen and append-only, so restore the old id and add a new field",
    ).toBe(FIELD_TABLE_DIGEST);
  });
});
