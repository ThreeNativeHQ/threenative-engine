import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planKitContract } from "../../packages/playtest/src/kit-contract.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { allTemplates } from "../../test-support/templates.js";
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
