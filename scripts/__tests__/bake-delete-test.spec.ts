import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  type IBakeDeleteTestDependencies,
  type IScenarioRun,
  assertScenarioAsserts,
  compareCaptures,
  deletePlan,
  deletionPlan,
  disableAssetWatcher,
  formatReport,
  judge,
  readReceipt,
  runBakeDeleteTest,
} from "../bake-delete-test.js";

/** A solid frame, so a difference in the comparison is arithmetic rather than encoder noise. */
function frame(red: number, green = red, blue = red): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

const SCENARIO = {
  assert: { diagnostics: { runtimeReady: true } },
  name: "play",
  steps: [{ kind: "wait", waitTicks: 10 }],
};

async function project(scenario: unknown = SCENARIO): Promise<string> {
  const root = await makeTempDir("delete-test-project-");
  await mkdir(path.join(root, "playtests"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(
    path.join(root, "playtests", "play.playtest.json"),
    JSON.stringify(scenario, null, 2),
  );
  await writeFile(path.join(root, "public", "rock.abcd1234.ktx2"), "baked");
  await writeFile(path.join(root, "public", "assets.manifest.json"), "{}");
  await writeFile(
    path.join(root, "public", "bake.receipt.json"),
    JSON.stringify({
      outputs: [{ bytes: 5, path: "rock.abcd1234.ktx2", producer: "ktx2", source: "rock.png" }],
      pipelineVersion: 8,
    }),
  );
  return root;
}

function dependencies(
  overrides: Partial<IBakeDeleteTestDependencies> & { runs?: IScenarioRun[] } = {},
): IBakeDeleteTestDependencies {
  const runs = overrides.runs ?? [];
  let call = 0;
  const frames = [frame(100), frame(101), frame(101)];
  return {
    build: overrides.build ?? (async () => undefined),
    disableWatcher: overrides.disableWatcher ?? (async () => undefined),
    readCapture:
      overrides.readCapture ??
      (async (artifacts) => {
        if (artifacts.endsWith("baked-a")) return frames[0] as Buffer;
        if (artifacts.endsWith("baked-b")) return frames[1] as Buffer;
        return frames[2] as Buffer;
      }),
    runScenario:
      overrides.runScenario ??
      (async () => {
        const result = runs[call] ?? { detail: "", ok: true };
        call += 1;
        return result;
      }),
    scaffold: overrides.scaffold ?? (async (_template, root) => root),
  };
}

describe("bake delete-test", () => {
  it("should throw when the receipt is missing", async () => {
    const root = await makeTempDir("delete-test-no-receipt-");
    await expect(readReceipt(root)).rejects.toThrow(/TN_DELETE_TEST_NO_RECEIPT/u);
  });

  it("should throw when the receipt is empty", async () => {
    const root = await makeTempDir("delete-test-empty-receipt-");
    await writeFile(
      path.join(root, "bake.receipt.json"),
      JSON.stringify({ outputs: [], pipelineVersion: 8 }),
    );
    await expect(readReceipt(root)).rejects.toThrow(/TN_DELETE_TEST_EMPTY_RECEIPT/u);
  });

  it("should refuse to delete a path outside the output root", () => {
    expect(() =>
      deletionPlan(
        {
          outputs: [{ bytes: 1, path: "../../assets/rock.png", producer: "x", source: null }],
          pipelineVersion: 8,
        },
        "/tmp/game/public",
      ),
    ).toThrow(/TN_DELETE_TEST_ESCAPES_ROOT/u);
  });

  it("should plan the manifest and the receipt alongside every declared output", () => {
    const plan = deletionPlan(
      {
        outputs: [{ bytes: 1, path: "basis/basis_transcoder.js", producer: "x", source: null }],
        pipelineVersion: 8,
      },
      "/tmp/game/public",
    );
    expect(plan).toEqual([
      path.resolve("/tmp/game/public/basis/basis_transcoder.js"),
      path.resolve("/tmp/game/public/assets.manifest.json"),
      path.resolve("/tmp/game/public/bake.receipt.json"),
    ]);
  });

  it("should throw rather than report success when there was nothing to delete", async () => {
    const root = await makeTempDir("delete-test-nothing-");
    await expect(deletePlan([path.join(root, "absent.ktx2")])).rejects.toThrow(
      /TN_DELETE_TEST_DELETED_NOTHING/u,
    );
  });

  it("should throw when the scenario asserts nothing", () => {
    expect(() => assertScenarioAsserts({ steps: [{ kind: "wait" }] }, "play.json")).toThrow(
      /TN_DELETE_TEST_EMPTY_SCENARIO/u,
    );
    expect(() =>
      assertScenarioAsserts({ assert: {}, steps: [{ kind: "wait" }] }, "p.json"),
    ).toThrow(/TN_DELETE_TEST_EMPTY_SCENARIO/u);
    expect(() => assertScenarioAsserts({ steps: [] }, "play.json")).toThrow(
      /TN_DELETE_TEST_EMPTY_SCENARIO/u,
    );
    expect(() => assertScenarioAsserts(SCENARIO, "play.json")).not.toThrow();
  });

  it("should measure the picture difference between two frames", () => {
    expect(compareCaptures(frame(100), frame(100))).toEqual({ meanAbsolute: 0, movedRatio: 0 });
    expect(compareCaptures(frame(100), frame(110))).toEqual({ meanAbsolute: 10, movedRatio: 1 });
  });

  it("should pass a change inside the band and fail one beyond it", () => {
    expect(
      judge({ meanAbsolute: 2, movedRatio: 0.6 }, { meanAbsolute: 5, movedRatio: 0.6 }),
    ).toEqual([]);
    expect(
      judge({ meanAbsolute: 2, movedRatio: 0.6 }, { meanAbsolute: 30, movedRatio: 0.9 }),
    ).toHaveLength(1);
    // A zero band must not make every run red: the ceiling has a floor of one level.
    expect(
      judge({ meanAbsolute: 0, movedRatio: 0 }, { meanAbsolute: 0.5, movedRatio: 0.1 }),
    ).toEqual([]);
  });

  it("should pass when the game runs identically without its bake", async () => {
    const root = await project();
    const report = await runBakeDeleteTest(
      { root, scenario: "playtests/play.playtest.json", template: "starter" },
      dependencies(),
    );
    expect(report.pass).toBe(true);
    expect(report.deleted).toHaveLength(3);
    expect(formatReport(report)).toContain("runs identically without its bake");
  });

  it("should fail, naming the deleted asset, when the second run does not complete", async () => {
    const root = await project();
    const report = await runBakeDeleteTest(
      { root, scenario: "playtests/play.playtest.json", template: "starter" },
      dependencies({
        runs: [
          { detail: "", ok: true },
          { detail: "", ok: true },
          { detail: "404 /rock.abcd1234.ktx2", ok: false },
        ],
      }),
    );
    expect(report.pass).toBe(false);
    expect(report.reasons[0]).toContain("TN_DELETE_TEST_UNBAKED_RUN_FAILED");
    expect(report.reasons[0]).toContain("rock.abcd1234.ktx2");
  });

  it("should fail when the unbaked picture moves beyond the band", async () => {
    const root = await project();
    const report = await runBakeDeleteTest(
      { root, scenario: "playtests/play.playtest.json", template: "starter" },
      dependencies({
        readCapture: async (artifacts) =>
          artifacts.endsWith("unbaked")
            ? frame(180)
            : frame(artifacts.endsWith("baked-a") ? 100 : 101),
      }),
    );
    expect(report.pass).toBe(false);
    expect(report.reasons[0]).toContain("TN_DELETE_TEST_PICTURE_MOVED");
  });

  it("should refuse to run at all when it cannot switch the asset watcher off", async () => {
    const root = await makeTempDir("delete-test-watcher-");
    await writeFile(path.join(root, "vite.config.ts"), "export default {};\n");
    await expect(disableAssetWatcher(root)).rejects.toThrow(/TN_DELETE_TEST_WATCHER_UNKNOWN/u);
  });

  it("should comment the watcher out of a config that installs it", async () => {
    const root = await makeTempDir("delete-test-watcher-ok-");
    await writeFile(
      path.join(root, "vite.config.ts"),
      "export default defineConfig({\n  plugins: [threenative(), react()],\n});\n",
    );
    await disableAssetWatcher(root);
    const patched = await readFile(path.join(root, "vite.config.ts"), "utf8");
    expect(patched).toContain("plugins: [threenative({ assetsWatch: false }), react()]");
  });

  it("should refuse to measure anything when the baked run already fails", async () => {
    const root = await project();
    await expect(
      runBakeDeleteTest(
        { root, scenario: "playtests/play.playtest.json", template: "starter" },
        dependencies({ runs: [{ detail: "assertion failed", ok: false }] }),
      ),
    ).rejects.toThrow(/TN_DELETE_TEST_BAKED_RUN_FAILED/u);
  });
});
