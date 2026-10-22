import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureQuery } from "../unreal-look/captureQuery.js";

describe("captureQuery", () => {
  it("bakes the GI cache in one call unless the run names giProgressive", () => {
    expect(captureQuery({})).toBe("&giProgressive=0");
    expect(captureQuery({ TN_UNREAL_LOOK_QUERY: "&envMul=2" })).toBe("&giProgressive=0&envMul=2");
    expect(captureQuery({ TN_UNREAL_LOOK_QUERY: "&giProgressive=1" })).toBe("&giProgressive=1");
  });

  it("is the only way the capture scripts read the query", () => {
    for (const file of ["capture-threenative.ts", "capture-gi-threenative.ts"]) {
      const source = readFileSync(new URL(`../unreal-look/${file}`, import.meta.url), "utf8");
      expect(source).not.toContain("process.env.TN_UNREAL_LOOK_QUERY");
      expect(source).toContain("captureQuery()");
    }
  });
});
