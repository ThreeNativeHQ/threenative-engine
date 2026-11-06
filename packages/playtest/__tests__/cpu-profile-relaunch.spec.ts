import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";

// A worker game relaunches with that thread's measurement flags (PRD-752), and the attempt that
// relaunches is thrown away. Its `--cpu-prof` session is not the run's profile: writing it reports
// a fragment of a discarded attempt on stderr and then the retry overwrites the same path. The
// profile a run reports must be the one the attempt that produced the report collected.
const fixture = vi.hoisted(() => ({
  opens: 0,
  starts: 0,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        close: async () => undefined,
        newPage: async () => ({
          addInitScript: async () => undefined,
          context: () => ({
            newCDPSession: async () => {
              // Each attempt opens its own session, so a profile names the attempt that collected it.
              let attempt = 0;
              return {
                send: async (method: string) => {
                  if (method === "Profiler.start") attempt = ++fixture.starts;
                  if (method !== "Profiler.stop") return {};
                  return { profile: { attempt, nodes: [], samples: [], timeDeltas: [] } };
                },
              };
            },
          }),
          evaluate: async () => true,
          on: () => undefined,
          // The page's game draws from a worker, which is what the runner relaunches for.
          workers: () => [{ evaluate: async () => "object" }],
        }),
      }),
    }),
  },
}));

vi.mock("../src/runner/browserSession.js", async (original) => ({
  ...await original<typeof import("../src/runner/browserSession.js")>(),
  remoteBrowserFor: () => undefined,
  playwrightProfileDirectories: () => [],
  removeStrandedProfiles: () => [],
  teardownBrowserSession: async () => undefined,
  openRunnerPage: async () => {
    fixture.opens++;
    // The relaunch re-opens the page; stop there so the retry's profile is the last one written.
    if (fixture.opens > 1) throw new Error("relaunched attempt stops here");
    return undefined;
  },
}));

// The relaunch only exists because a private Xvfb does not pace a worker's OffscreenCanvas frames.
vi.mock("../src/evaluators/frame-cost.js", async (original) => ({
  ...await original<typeof import("../src/evaluators/frame-cost.js")>(),
  frameDisplay: () => "virtual",
}));

import { runStandalonePlaytest } from "../src/runner/runner.js";

test("a worker relaunch does not report the discarded attempt's cpu profile", async () => {
  fixture.opens = 0;
  fixture.starts = 0;
  const directory = await makeTempDir("tn-cpu-profile-relaunch-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    schemaVersion: 1,
    name: "cpu-profile-relaunch",
    target: "web",
    warmupFrames: 0,
    artifacts: { screenshots: false },
    viewport: { width: 64, height: 64 },
    awaitStartup: false,
    assert: { performance: { maxFrameMsP95: 16 } },
    steps: [{ waitTicks: 1 }],
  }));
  const stderr: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    await expect(runStandalonePlaytest({
      artifactDirectory: directory,
      cpuProfilePath: join(directory, "run.cpuprofile"),
      headless: true,
      projectPath: directory,
      scenarioPath: "scenario.json",
      timeoutMs: 15000,
      trace: false,
      url: "http://fixture.invalid",
    })).rejects.toThrow(/relaunched attempt stops here/);
  } finally {
    write.mockRestore();
  }
  // Both attempts began a profile; only the retry's belongs to the run, so only it is reported.
  expect(fixture.starts).toBe(2);
  expect(stderr.filter((line) => line.includes('"cpuProfile"'))).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, "run.cpuprofile"), "utf8")).attempt).toBe(2);
});
