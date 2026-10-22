import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string): string =>
  readFileSync(new URL(`../unreal-look/${file}`, import.meta.url), "utf8");

// PRD-649: a provisional GI upload before the final one changes the settled frame on the owned engine, so the
// progressive bake is opt-in until that engine defect is fixed.
describe("progressive GI bake", () => {
  it("is on only when the page names giProgressive=1", () => {
    expect(read("scaffold/Reference.ts.in")).toContain('params.get("giProgressive") !== "1"');
    expect(read("scaffold/CalibrationScene.ts.in")).toContain(
      'params.get("giProgressive") === "1"',
    );
    for (const file of ["scaffold/Reference.ts.in", "scaffold/CalibrationScene.ts.in"])
      expect(read(file)).not.toContain('params.get("giProgressive") !== "0"');
  });

  it("is what the startup bench times unless the run names its own", () => {
    expect(read("startup-bench.ts")).toContain(
      "`&giProgressive=1${process.env.TN_UNREAL_LOOK_QUERY",
    );
  });
});
