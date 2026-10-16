import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkNativeCoverage, nativeCoverageGateErrors } from "../check-native-coverage.js";

const record = `
Source digest: \`sha256:aaaa\`

| Subsystem | Instrumented lines | Covered | Line coverage |
| --- | ---: | ---: | ---: |
| \`src/webgpu/\` | 100 | 35 | 35.00% |
| \`src/js/\` | 100 | 40 | 40.00% |

| Coverage floor | Minimum |
| --- | ---: |
| \`src/webgpu/\` | 34.00% |
| \`src/js/\` | 40.00% |
`;

describe("native coverage gate", () => {
  it("keeps the committed measured record fresh for the exact coverage execution inputs", async () => {
    await expect(
      checkNativeCoverage(fileURLToPath(new URL("../../", import.meta.url))),
    ).resolves.toBeUndefined();
  });
  it("should fail when a subsystem drops below its floor", () => {
    const belowFloor = record.replace("| 100 | 35 | 35.00% |", "| 100 | 33 | 33.00% |");
    expect(nativeCoverageGateErrors(belowFloor, "aaaa")).toEqual([
      "native coverage dropped: src/webgpu/ measured 33.00%, floor 34.00%",
    ]);
  });

  it("should fail when the report is stale or missing", async () => {
    expect(nativeCoverageGateErrors(record, "bbbb")).toEqual([
      "native coverage report is stale: source digest changed to bbbb; run `pnpm --filter @threenative/runtime-native native:coverage`",
    ]);
    expect(() => nativeCoverageGateErrors("", "aaaa")).toThrow(
      /native coverage record is missing its source digest/u,
    );
    await expect(checkNativeCoverage("/definitely/missing/native-coverage-root")).rejects.toThrow(
      /native coverage record is missing/u,
    );
  });

  it("should pass at each recorded subsystem floor", () => {
    expect(nativeCoverageGateErrors(record, "aaaa")).toEqual([]);
  });

  it("should reject a floor looser than the measured value by more than the margin", () => {
    const loose = record.replace("| `src/webgpu/` | 34.00% |", "| `src/webgpu/` | 20.00% |");
    expect(nativeCoverageGateErrors(loose, "aaaa")).toEqual([
      "native coverage floor too loose: src/webgpu/ floor 20.00%, measured 35.00%; raise it to at least 30.00% (measured - 5 percentage points)",
    ]);
  });

  it("should reject incomplete or duplicate floor sets", () => {
    expect(nativeCoverageGateErrors(record.replace("| `src/js/` | 40.00% |", ""), "aaaa")).toEqual([
      expect.stringContaining("floor set differs"),
    ]);
    expect(() =>
      nativeCoverageGateErrors(
        record.replace("| `src/js/` | 40.00% |", "| `src/js/` | 40.00% |\n| `src/js/` | 40.00% |"),
        "aaaa",
      ),
    ).toThrow(/duplicate row: src\/js\//u);
  });

  it("should ratchet improved coverage while retaining established regression floors", async () => {
    const coverageModule = (await import(
      new URL("../../packages/runtime-native/scripts/measure-native-coverage.mjs", import.meta.url)
        .href
    )) as {
      retainedCoverageFloors(
        previousRecord: string,
        subsystems: Array<{ name: string; percent: number }>,
      ): Array<{ name: string; percent: number }>;
    };
    const improved = record.replace("34.00%", "20.00%");
    expect(
      coverageModule.retainedCoverageFloors(improved, [
        { name: "webgpu", percent: 35 },
        { name: "js", percent: 40 },
      ]),
    ).toEqual([
      { name: "src/webgpu/", percent: 30 },
      { name: "src/js/", percent: 40 },
    ]);
    const established = record.replace("34.00%", "33.82%");
    expect(
      coverageModule.retainedCoverageFloors(established, [
        { name: "webgpu", percent: 32.82 },
        { name: "js", percent: 40 },
      ]),
    ).toEqual([
      { name: "src/webgpu/", percent: 33.82 },
      { name: "src/js/", percent: 40 },
    ]);
    const regressed = established.replace("| 100 | 35 | 35.00% |", "| 100 | 33 | 32.82% |");
    expect(nativeCoverageGateErrors(regressed, "aaaa")).toContain(
      "native coverage dropped: src/webgpu/ measured 32.82%, floor 33.82%",
    );
  });
});
