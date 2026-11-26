// PRD-099 AC-9: an agent holding only the installed capability manifest finds cloud saves the same
// way it finds every other engine capability, and no row still says the framework owns no save
// system. Before this spec the only cloud-save answers were the host-side handler and `BackendDb`:
// the client's entry point (`createBackend`) was invisible to the words a brief uses.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityDetail, loadCapabilityManifest, searchCapabilities } from "../src/index.js";

const manifest = path.resolve("packages/core/capabilities.json");

/** The one symbol a save request must reach, checked by name so a wrong package fails by name. */
function backendHit(situation: string, symbol: string) {
  const response = searchCapabilities(situation, manifest, "mechanic");
  expect(response.verdict).toBe("matched");
  const hit = response.results.find((result) => result.symbol === symbol);
  expect(
    hit,
    `${symbol} missing from: ${response.results.map((result) => result.symbol).join(", ")}`,
  ).toBeDefined();
  return hit;
}

describe("cloud save discovery", () => {
  it("resolves the mechanic query 'cloud save' to the @threenative/backend client", () => {
    const hit = backendHit("cloud save", "createBackend");
    expect(hit?.importPath).toBe("@threenative/backend");
    expect(hit?.requires).toContain("npm i @threenative/backend");
  });

  it("hands the author the install line and the no-host promise", () => {
    const text = JSON.stringify(capabilityDetail("createBackend", manifest));
    expect(text).toContain("npm i @threenative/backend");
    expect(text).toContain("preview build that has no backend");
  });

  it("no longer tells the agent the framework owns no save system", () => {
    const owned = loadCapabilityManifest(manifest);
    expect(owned.notOwned.map((row) => row.id)).not.toContain("save-load");
    expect(JSON.stringify(owned.notOwned)).not.toMatch(/save system/iu);
    const response = searchCapabilities("save the player's progress across reloads", manifest);
    expect(response.verdict).toBe("matched");
    expect(response.results.map((result) => result.importPath)).toContain("@threenative/backend");
    expect(response.guidance).not.toMatch(/owns no save system/iu);
  });
});
