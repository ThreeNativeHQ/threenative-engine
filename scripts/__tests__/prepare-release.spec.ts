import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import type { RegistryLookup } from "../check-publish-state.js";
import {
  assertOneZeroGatesClosed,
  nextPatch,
  selectReleaseVersions,
  syncSourceVersions,
} from "../prepare-release.js";

describe("release preparation", () => {
  it("increments only the patch component", () => {
    expect(nextPatch("0.3.0")).toBe("0.3.1");
    expect(nextPatch("1.2.9")).toBe("1.2.10");
  });

  it("keeps an entirely absent cohort idempotent", () => {
    const packages = [
      { name: "@threenative/core", version: "0.3.1" },
      { name: "create-threenative", version: "0.2.4" },
    ];
    const selected = selectReleaseVersions(packages, () => ({ state: "absent" }));

    expect([...selected.values()]).toEqual([
      { current: "0.3.1", next: "0.3.1", published: false },
      { current: "0.2.4", next: "0.2.4", published: false },
    ]);
  });

  it("bumps the entire cohort and skips occupied patch versions", () => {
    const packages = [
      { name: "@threenative/core", version: "0.3.0" },
      { name: "@threenative/ui", version: "0.3.0" },
    ];
    const occupied = new Set([
      "@threenative/core@0.3.0",
      "@threenative/core@0.3.1",
      "@threenative/ui@0.3.0",
    ]);
    const lookup: RegistryLookup = (name, version) => ({
      state: occupied.has(`${name}@${version}`) ? "present" : "absent",
    });
    const selected = selectReleaseVersions(packages, lookup);

    expect([...selected.values()]).toEqual([
      { current: "0.3.0", next: "0.3.2", published: true },
      { current: "0.3.0", next: "0.3.1", published: true },
    ]);
  });

  it("fails closed when npm cannot answer", () => {
    expect(() =>
      selectReleaseVersions([{ name: "@threenative/core", version: "0.3.0" }], () => ({
        state: "unreachable",
      })),
    ).toThrow(/TN_RELEASE_REGISTRY_UNREACHABLE/u);
  });

  it("writes the core bump into the checked-in replay assertion", async () => {
    const repo = await makeTempDir("threenative-replay-pin-");
    const replay = "examples/abyss-framework/playtests/replay.playtest.json";
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const copied = [
      "packages/core/src/index.ts",
      "packages/create-threenative/src/doctor.ts",
      "packages/engine-mcp/src/index.ts",
      "packages/engine-mcp/__tests__/server.spec.ts",
      "packages/core/mcp/servers.mjs",
      "packages/create-threenative/engine-mcp-tools.json",
      replay,
    ];
    for (const relative of copied) {
      const target = path.join(repo, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, relative), target);
    }
    const versions = new Map([
      ["@threenative/core", "9.9.9"],
      ["threenative-engine-mcp", "9.9.9"],
    ]);

    syncSourceVersions(repo, versions);

    const scenario = JSON.parse(fs.readFileSync(path.join(repo, replay), "utf8")) as {
      assert: { movement?: unknown; world: { runtime: { core: string } } };
    };
    expect(scenario.assert.world.runtime.core).toBe("9.9.9");
    expect(scenario.assert.movement).toBeDefined();
  });
});

/**
 * PRD-446: 1.0.0 is the version that promises a game on N keeps working on N+1, so the cohort may not
 * claim it while the proof of that promise is open. The refusal is measured against the real PRD.
 */
describe("the 1.0.0 refusal", () => {
  const gate = "docs/PRDs/done/PRD-446-stable-api-and-upgrade-contract.md";

  it("accepts the real gate now that its last box is ticked, and still refuses one reopened", async () => {
    // The shipped gate is the archived PRD-446. Its proof landed, so a 1.0.0 cohort may proceed…
    expect(() => assertOneZeroGatesClosed()).not.toThrow();
    // …and the refusal is still measured against that real file: one box reopened is refused by
    // name, so the wiring cannot quietly point at a PRD that retired the promise.
    const root = await makeTempDir("threenative-gates-open-");
    const source = path.join(root, gate);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      fs
        .readFileSync(path.resolve(import.meta.dirname, "../..", gate), "utf8")
        .replace(/^- \[x\]/gmu, "- [ ]"),
    );
    expect(() => assertOneZeroGatesClosed(root, [gate])).toThrow(
      new RegExp(`TN_RELEASE_1_0_0_GATES_OPEN[\\s\\S]*${gate.replaceAll(".", "\\.")}`, "u"),
    );
  });

  it("accepts the same PRD once every phase and acceptance box is ticked", async () => {
    const root = await makeTempDir("threenative-gates-closed-");
    const source = path.join(root, gate);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const markdown = fs
      .readFileSync(path.resolve(import.meta.dirname, "../..", gate), "utf8")
      .replace(/^- \[ \]/gmu, "- [x]");
    fs.writeFileSync(source, markdown);
    expect(() => assertOneZeroGatesClosed(root, [gate])).not.toThrow();
  });

  it("fails closed when the gate PRD has moved rather than retiring its promise", () => {
    expect(() => assertOneZeroGatesClosed("/nowhere", [gate])).toThrow(
      /TN_RELEASE_1_0_0_GATE_MISSING/u,
    );
  });

  it("refuses a gate PRD with no phase boxes", async () => {
    const root = await makeTempDir("threenative-gates-empty-");
    const source = path.join(root, gate);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "# PRD-446\n\nNo phase boxes remain.\n");
    expect(() => assertOneZeroGatesClosed(root, [gate])).toThrow(/TN_RELEASE_1_0_0_GATE_EMPTY/u);
  });
});
