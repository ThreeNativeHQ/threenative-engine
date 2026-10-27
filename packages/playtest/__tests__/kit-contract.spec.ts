import { describe, expect, it } from "vitest";

import { KIT_CONTRACT_ROWS, KIT_CONTRACT_ROW_IDS, planKitContract } from "../src/kit-contract.js";
import type { IKitContractEntry } from "../src/kit-contract.js";
import { validatePlaytestScenario } from "../src/scenario.js";

const FULL: IKitContractEntry = {
  actions: [{ clip: "swing", contactTicks: 24, effect: { signal: "attack" }, key: "KeyF", ticks: 40 }],
  feet: ["footL", "footR"],
  move: ["KeyW", "KeyA"],
  restart: { key: "KeyR", resets: [{ equals: 0, id: "state", path: "score" }, { id: "state", lte: 1, path: "elapsed" }] },
  subject: "player",
};

/** A kit that declares nothing optional must opt out of every row that reads a declaration. */
const optOutOfDeclared = (reason = "this kit has no such mechanic to check"): IKitContractEntry => ({
  move: ["KeyW"],
  optOut: Object.fromEntries(
    KIT_CONTRACT_ROWS.filter(({ needs }) => !needs({ move: ["KeyW"], subject: "player" })).map(({ id }) => [id, reason]),
  ),
  subject: "player",
});

describe("kit contract", () => {
  it("builds a scenario the harness accepts for every row of a fully declared kit", () => {
    const plan = planKitContract({ demo: FULL }, ["demo"]);
    expect(plan.map(({ row }) => row)).toEqual(KIT_CONTRACT_ROW_IDS);
    for (const verdict of plan) {
      expect(verdict.kind).toBe("run");
      if (verdict.kind === "run") expect(() => validatePlaytestScenario(verdict.scenario, `${verdict.row}.json`)).not.toThrow();
    }
  });

  it("bounds a restart reset that keeps running with lte instead of equals", () => {
    const row = planKitContract({ demo: FULL }, ["demo"]).find(({ row: id }) => id === "restart-resets");
    const resources = (row?.kind === "run" ? row.scenario : {}) as { assert?: { resources?: { atSteps: object[] }[] } };
    expect(resources.assert?.resources?.map(({ atSteps }) => atSteps)).toEqual([
      [{ equals: 0, label: "settled" }],
      [{ label: "settled", lte: 1 }],
    ]);
  });

  it("reports an opt-out with its reason instead of dropping the row", () => {
    const plan = planKitContract({ demo: optOutOfDeclared() }, ["demo"]);
    const skipped = plan.filter(({ kind }) => kind === "opt-out");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((verdict) => verdict.kind === "opt-out" && verdict.reason.length > 0)).toBe(true);
  });

  it("fails closed when a kit neither declares what a row reads nor opts out", () => {
    expect(() => planKitContract({ demo: { move: ["KeyW"], subject: "player" } }, ["demo"])).toThrow(/TN_KIT_CONTRACT_UNDECLARED/u);
  });

  it("rejects an opt-out without a written reason", () => {
    const entry = optOutOfDeclared("n/a");
    expect(() => planKitContract({ demo: entry }, ["demo"])).toThrow(/TN_KIT_CONTRACT_OPT_OUT_REASON/u);
  });

  it("rejects an opt-out for an unknown row", () => {
    const entry = { ...FULL, optOut: { "no-such-row": "this row does not exist at all" } };
    expect(() => planKitContract({ demo: entry }, ["demo"])).toThrow(/TN_KIT_CONTRACT_UNKNOWN_ROW/u);
  });

  it("rejects a stale opt-out for a row the kit declares in full", () => {
    const entry = { ...FULL, optOut: { "foot-slip": "legs were slow once, long since fixed" } };
    expect(() => planKitContract({ demo: entry }, ["demo"])).toThrow(/TN_KIT_CONTRACT_STALE_OPT_OUT/u);
  });

  it("rejects a kit with no entry", () => {
    expect(() => planKitContract({}, ["ghost"])).toThrow(/TN_KIT_CONTRACT_KIT_UNDECLARED/u);
  });
});
