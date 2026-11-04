/**
 * The threejs diagnosis arm of a calibration capture (PRD-646): a named opt-in that lets one run draw on
 * upstream three, and a gate that refuses every frame it drew.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import {
  checkDrawnEngine,
  diagnosisCells,
  diagnosisCellsIn,
  engineName,
  refuseDiagnosis,
  selectedEngine,
  withEngine,
} from "../unreal-look/engineMode.js";
import { compareGi } from "../unreal-look/gi.js";
import { checkCommand, lockCommand } from "../unreal-look/giLocks.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
import { rmSync } from "node:fs";

/** A captures root whose ThreeNative side wrote `report` as its gi-capture.json. */
function capture(report: Record<string, unknown>): string {
  const root = makeTempDirSync("tn-engine-mode-");
  roots.push(root);
  mkdirSync(path.join(root, "threenative"), { recursive: true });
  writeFileSync(path.join(root, "threenative", "gi-capture.json"), `${JSON.stringify(report)}\n`);
  return root;
}

describe("the engine a calibration capture draws on (PRD-646)", () => {
  it("is the owned engine unless the run names threejs", () => {
    expect(selectedEngine({})).toBe("threenative");
    expect(selectedEngine({ TN_UNREAL_LOOK_ENGINE: "" })).toBe("threenative");
    expect(selectedEngine({ TN_UNREAL_LOOK_ENGINE: "threenative" })).toBe("threenative");
    expect(selectedEngine({ TN_UNREAL_LOOK_ENGINE: "threejs" })).toBe("threejs");
    expect(() => selectedEngine({ TN_UNREAL_LOOK_ENGINE: "mystral" })).toThrow(
      /TN_UNREAL_LOOK_ENGINE/,
    );
  });

  it("names a diagnosis frame as a diagnosis in every report line", () => {
    expect(engineName("threenative")).toBe("threenative");
    expect(engineName("threejs")).toBe("threejs (diagnosis)");
  });

  it("fails closed when the page drew on another engine than the run asked for", () => {
    expect(() => checkDrawnEngine("threejs", "threenative", "cornell L1")).toThrow(
      /TN_UNREAL_LOOK_WRONG_ENGINE: cornell L1 drew on threejs/,
    );
    expect(() => checkDrawnEngine(undefined, "threenative", "cornell L1")).toThrow(
      /WRONG_ENGINE: cornell L1 drew on undefined/,
    );
    expect(checkDrawnEngine("threejs", "threejs", "cornell L1")).toBeUndefined();
  });

  it("sets the scaffold's engine, and takes a previous arm's line back out", () => {
    const plain = 'const config = {\n  nativeEntry: "src/game.ts",\n};\n';
    const diagnosis = withEngine(plain, "threejs");
    expect(diagnosis).toBe(
      'const config = {\n  nativeEntry: "src/game.ts",\n  engine: "threejs",\n};\n',
    );
    // A threejs line never survives into the next run: the default draws on the owned engine again.
    expect(withEngine(diagnosis, "threenative")).toBe(plain);
    expect(withEngine(withEngine(diagnosis, "threejs"), "threejs")).toBe(diagnosis);
  });
});

describe("a gate refuses a diagnosis frame (PRD-646)", () => {
  it("names the cells a capture report drew on threejs", () => {
    expect(
      diagnosisCells({
        cells: 2,
        "cornell/L1": { engine: "threejs (diagnosis)" },
        "sunlit-room/L1": { engine: "threenative" },
      }),
    ).toEqual(["cornell/L1"]);
    expect(diagnosisCells({ cells: 0 })).toEqual([]);
    expect(diagnosisCells(undefined)).toEqual([]);
    expect(diagnosisCellsIn(capture({ "cornell/L1": { engine: "threenative" } }))).toEqual([]);
  });

  it("fails closed with TN_UNREAL_LOOK_DIAGNOSIS_ONLY, naming what it would have gated", () => {
    expect(() => refuseDiagnosis([], "the L1 row verdict")).not.toThrow();
    expect(() => refuseDiagnosis(["cornell/L1", "corner/L1"], "the L1 row verdict")).toThrow(
      /TN_UNREAL_LOOK_DIAGNOSIS_ONLY: the L1 row verdict would gate 2 cell\(s\).*cornell\/L1, corner\/L1/,
    );
  });

  it("refuses the row verdict and the statistics of a diagnosis capture", () => {
    const diagnosis = capture({ "cornell/L1": { engine: "threejs (diagnosis)" } });
    expect(() =>
      compareGi(["--scene", "gi:cornell", "--layer", "L1", "--captures", diagnosis]),
    ).toThrow(/TN_UNREAL_LOOK_DIAGNOSIS_ONLY/);
    // The default arm is not refused: it reaches the frames, which this root does not hold.
    const owned = capture({ "cornell/L1": { engine: "threenative" } });
    expect(() =>
      compareGi(["--scene", "gi:cornell", "--layer", "L1", "--captures", owned]),
    ).not.toThrow(/TN_UNREAL_LOOK_DIAGNOSIS_ONLY/);
  });

  it("refuses a lock check and a lock write cut from a diagnosis capture", () => {
    const diagnosis = capture({ "cornell/L7": { engine: "threejs (diagnosis)" } });
    const deps = {
      compare: () => [],
      basis: () => "basis",
      log: () => {},
      error: () => {},
    };
    // A lock names the run folder itself: the folder that holds `<scene>/<layer>` and the report.
    const run = path.join(diagnosis, "threenative");
    expect(() =>
      checkCommand(["--check", "--scene", "gi:cornell", "--layer", "L7", "--captures", run], deps),
    ).toThrow(/TN_UNREAL_LOOK_DIAGNOSIS_ONLY: cornell lock check/);
    expect(() =>
      lockCommand(
        ["--write-locks", "head", "--scene", "gi:cornell", "--layer", "L7", "--captures", run],
        deps,
      ),
    ).toThrow(/TN_UNREAL_LOOK_DIAGNOSIS_ONLY: the cornell L7 lock/);
  });
});
