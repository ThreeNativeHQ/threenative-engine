import { readFile } from "node:fs/promises";
import validator from "gltf-validator";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import * as environment from "../src/index.js";

// The Khronos validator's codes for the two spec violations the generators once wrote.
const CODES = ["ACCESSOR_NON_CLAMPED", "ACCESSOR_VECTOR3_NON_UNIT"];

type Baker = (options: Record<string, unknown>) => Promise<{ path: string }[]>;

/** Bakes an element through the call its `bake` field documents, into `out`. */
async function bakeElement(bake: string, out: string): Promise<string[]> {
  const call = /^(\w+)\((.*)\)$/s.exec(bake);
  if (call === null) throw new Error(`unparsable bake call: ${bake}`);
  const options = new Function(`return (${call[2]})`)() as Record<string, unknown>;
  const fn = (environment as unknown as Record<string, Baker>)[call[1] ?? ""];
  if (fn === undefined) throw new Error(`no export ${call[1]}`);
  return (await fn({ ...options, out })).map((baked) => baked.path);
}

describe("every baked recipe is valid glTF", () => {
  it("has no unclamped COLOR_0 and no non-unit NORMAL", { timeout: 600_000 }, async () => {
    const out = await makeTempDir("tn-gltf-valid-");
    const failures: string[] = [];
    for (const element of environment.environmentElements()) {
      for (const file of await bakeElement(element.bake, out)) {
        const report = await validator.validateBytes(new Uint8Array(await readFile(file)));
        for (const message of report.issues.messages)
          if (CODES.includes(message.code)) failures.push(`${element.id}: ${message.code}`);
      }
    }
    expect([...new Set(failures)]).toEqual([]);
  });
});
