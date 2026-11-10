import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOLD_RELATIVE_PATH,
  SEARCH_GOLD_EXACT_SYMBOL_COUNT,
  SEARCH_GOLD_HELDOUT_COUNT,
  SEARCH_GOLD_QUERY_COUNT,
  loadGoldSet,
  reportArm,
} from "../../../scripts/capability-search-ab.js";
import { capabilityDetails, searchCapabilities } from "../src/index.js";

const workspaceManifest = path.resolve("packages/core/capabilities.json");
const goldFile = path.resolve(GOLD_RELATIVE_PATH);
const prdFile = path.resolve(
  "docs/PRDs/done/PRD-865-capability-search-finds-by-name-and-answers-in-one-call.md",
);

/**
 * The floor the candidate measured when PRD-865 landed (0.620 recall@1, 0.780 recall@5). A later
 * change that drops the held-out half below it fails here instead of shipping the regression; the
 * base arm measures 0.400 recall@1 and 0.580 recall@5 at ecd2a1a56 and fails both lines.
 */
const LOCKED_HELDOUT_RECALL_1 = 0.6;
const LOCKED_HELDOUT_RECALL_5 = 0.76;

const arm = { capabilityDetails, searchCapabilities };

describe("capability search gold set", () => {
  it("holds 150 real queries, split 100 dev and 50 held out, with 20 exact-symbol queries", async () => {
    const gold = await loadGoldSet(workspaceManifest, goldFile);
    const heldout = gold.rows.filter((row) => row.split === "heldout");
    const dev = gold.rows.filter((row) => row.split === "dev");

    expect(gold.rows).toHaveLength(SEARCH_GOLD_QUERY_COUNT);
    expect(heldout).toHaveLength(SEARCH_GOLD_HELDOUT_COUNT);
    expect(dev).toHaveLength(SEARCH_GOLD_QUERY_COUNT - SEARCH_GOLD_HELDOUT_COUNT);
    expect(gold.rows.filter((row) => row.kind === "exact-symbol")).toHaveLength(
      SEARCH_GOLD_EXACT_SYMBOL_COUNT,
    );
  });

  /**
   * The split is only a control while it is frozen: the hash is in the fixture and in the PRD, so
   * editing a held-out label to make a change pass fails here as well as in the A/B harness.
   */
  it("freezes the held-out labels by the sha256 recorded in PRD-865", async () => {
    const gold = await loadGoldSet(workspaceManifest, goldFile);
    expect(await readFile(prdFile, "utf8")).toContain(gold.heldoutSha256);
  });

  it("finds every exact symbol name the manifest exports as the first row (AC-2)", async () => {
    const gold = await loadGoldSet(workspaceManifest, goldFile);
    const misses = gold.rows
      .filter((row) => row.kind === "exact-symbol")
      .map((row) => ({
        first: searchCapabilities(row.query, workspaceManifest).results[0]?.symbol,
        query: row.query,
        symbol: row.expect[0],
      }))
      .filter((row) => row.first !== row.symbol);

    expect(misses).toEqual([]);
  });

  /**
   * The one number a later change can quietly lose. Measured on the held-out half only, with the
   * same harness the A/B uses, so tuning against `dev` cannot lower this floor.
   */
  it("keeps the locked held-out recall floor", async () => {
    const gold = await loadGoldSet(workspaceManifest, goldFile);
    const report = reportArm(arm, gold, workspaceManifest, "heldout");

    expect(report.recall1).toBeGreaterThanOrEqual(LOCKED_HELDOUT_RECALL_1);
    expect(report.recall5).toBeGreaterThanOrEqual(LOCKED_HELDOUT_RECALL_5);
  });
});
