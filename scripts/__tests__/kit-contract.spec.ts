import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type IKitContractEntry,
  KIT_CONTRACT_ROWS,
  planKitContract,
} from "../../packages/playtest/src/kit-contract.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { allTemplates } from "../../test-support/templates.js";
import { writeKitContractRow } from "../kit-contract-row.js";
import {
  assertKitContractPassed,
  formatKitContractMatrix,
  loadKitContract,
  runKitContract,
  summarizeReport,
} from "../kit-contract.js";

describe("kit contract declarations", () => {
  it("declares every kit on disk and plans every row, with each scenario valid for the harness", async () => {
    const entries = await loadKitContract();
    const kits = allTemplates();
    expect(Object.keys(entries).sort()).toEqual([...kits].sort());
    const plan = planKitContract(entries, kits);
    expect(plan.length).toBeGreaterThan(kits.length);
    for (const verdict of plan) {
      if (verdict.kind === "run")
        expect(() =>
          validatePlaytestScenario(verdict.scenario, `${verdict.kit}/${verdict.row}.json`),
        ).not.toThrow();
    }
  });
});

describe("kit contract sweep", () => {
  it("runs one scenario per row, reports opt-outs with their reason, and fails the sweep on a red row", async () => {
    const root = await makeTempDir("kit-contract-");
    const entries = {
      demo: {
        engineCost: {
          maxPerFrame: { bridgeCrossings: 600 },
          source: "demo after-values, a fixture bound",
        },
        move: ["KeyW"],
        optOut: {
          "action-clip-completes": "no key plays an animation clip",
          "effect-follows-contact": "no melee or timed hit with a contact window",
          "foot-slip": "the subject has no legs at all",
          "restart-resets": "a sandbox with no run to restart",
        },
        subject: "player",
      },
    };
    const ran: string[] = [];
    const results = await runKitContract(
      ["demo"],
      root,
      {},
      {
        entries,
        runScenario: async (_kit, _target, scenarioPath) => {
          ran.push(path.basename(scenarioPath));
          return scenarioPath.includes("hud-clean")
            ? { detail: "failed hudAudit.debugText", pass: false }
            : { pass: true };
        },
        scaffold: async (_kit, target) => {
          await mkdir(target, { recursive: true });
        },
      },
    );
    expect(ran.sort()).toEqual([
      "camera-sees-subject.playtest.json",
      "engine-cost.playtest.json",
      "explore-clean.playtest.json",
      "hud-clean.playtest.json",
      "no-hitch.playtest.json",
    ]);
    expect(results.filter(({ status }) => status === "opt-out")).toHaveLength(4);
    expect(results.find(({ row }) => row === "hud-clean")).toMatchObject({
      detail: "failed hudAudit.debugText",
      status: "fail",
    });
    expect(formatKitContractMatrix(results)).toContain(
      "FAIL demo hud-clean: failed hudAudit.debugText",
    );
    expect(() => assertKitContractPassed(results)).toThrow(
      /TN_KIT_CONTRACT_FAILED: demo\/hud-clean/u,
    );
  });

  it("names the failing assertions from a report and falls back to the stderr tail", () => {
    const report = JSON.stringify({
      assertions: [
        { id: "a", pass: true },
        { id: "sightLine", pass: false },
      ],
      diagnostics: [{ code: "TN_PLAYTEST_SIGHT_LINE_BLOCKED" }],
    });
    expect(summarizeReport(report, "")).toBe("failed sightLine; TN_PLAYTEST_SIGHT_LINE_BLOCKED");
    expect(summarizeReport("", "boom\nTN_PLAYTEST_BRIDGE_MISSING")).toContain(
      "TN_PLAYTEST_BRIDGE_MISSING",
    );
  });
});

describe("one contract row for a CI job", () => {
  it("writes the row for every kit that declares it and nothing for every kit that opts out", async () => {
    const root = await makeTempDir("kit-contract-row-");
    // Which shipped kit is pinned to three.js changes lane by lane, so the test reads the shipped
    // declarations rather than naming one: a kit either declares its `engine-cost` bounds or opts
    // out of the row with a reason, and the writer follows that.
    const entries = await loadKitContract();
    const kits = Object.keys(entries);
    expect(kits.length).toBeGreaterThan(0);
    let declared = 0;
    let optedOut = 0;
    for (const kit of kits) {
      const directory = path.join(root, kit);
      const written = await writeKitContractRow("engine-cost", kit, directory);
      if (entries[kit]?.optOut?.["engine-cost"] !== undefined) {
        expect(written).toBeUndefined();
        await expect(readdir(directory)).rejects.toThrow();
        optedOut += 1;
        continue;
      }
      const scenario = JSON.parse(await readFile(written as string, "utf8")) as {
        assert: { engineCost?: object };
      };
      expect(scenario.assert.engineCost).toBeDefined();
      declared += 1;
    }
    expect(declared).toBeGreaterThan(0);
    expect(declared + optedOut).toBe(kits.length);
    await expect(writeKitContractRow("no-such-row", kits[0] as string, root)).rejects.toThrow(
      /no such row/u,
    );
  });

  it("writes nothing for a fixture kit that opts out, so the no-row path survives every unpinning", async () => {
    const root = await makeTempDir("kit-contract-row-fixture-");
    const base = { move: ["KeyW"], subject: "player" } as const;
    const fixture: Record<string, IKitContractEntry> = {
      demo: {
        ...base,
        optOut: Object.fromEntries(
          KIT_CONTRACT_ROWS.filter(({ needs }) => !needs(base)).map(({ id }) => [
            id,
            id === "engine-cost"
              ? "a fixture kit pinned to three.js: no web engine counters to bound"
              : "a fixture kit that declares nothing this row reads",
          ]),
        ),
      },
    };
    expect(Object.keys(fixture.demo?.optOut ?? {})).toContain("engine-cost");
    expect(
      await writeKitContractRow("engine-cost", "demo", path.join(root, "demo"), fixture),
    ).toBeUndefined();
    await expect(readdir(path.join(root, "demo"))).rejects.toThrow();
  });
});
