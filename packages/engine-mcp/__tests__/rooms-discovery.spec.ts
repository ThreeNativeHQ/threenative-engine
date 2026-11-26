// PRD-100 AC-6: an agent holding only the installed capability manifest finds hosted rooms the
// same way it finds every other engine capability. Before this spec the only multiplayer answer
// was `@threenative/core/net` plus "write the server yourself": the rooms client was invisible to
// the words a brief actually uses, and `networked-multiplayer` still sent the agent off to build
// what the backend already ships.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityDetail, loadCapabilityManifest, searchCapabilities } from "../src/index.js";

const manifest = path.resolve("packages/core/capabilities.json");

/** The symbol a lobby request must reach, checked by name so a wrong package fails by name. */
function roomsHit(query: string, symbol: string) {
  const response = searchCapabilities(query, manifest, "mechanic");
  expect(response.verdict).toBe("matched");
  const hit = response.results.find((result) => result.symbol === symbol);
  expect(
    hit,
    `${symbol} missing from: ${response.results.map((result) => result.symbol).join(", ")}`,
  ).toBeDefined();
  return hit;
}

describe("online multiplayer discovery", () => {
  it("resolves the mechanic query 'online multiplayer lobby' to the rooms client", () => {
    const hit = roomsHit("online multiplayer lobby", "BackendRooms");
    expect(hit?.importPath).toBe("@threenative/backend");
    expect(hit?.requires).toContain("npm i @threenative/backend");
  });

  it("finds the joined room a game sends on, by its lobby vocabulary", () => {
    expect(roomsHit("players in one room send messages to each other", "Room")?.importPath).toBe(
      "@threenative/backend",
    );
  });

  it("hands the author the install line and a joining call", () => {
    const detail = capabilityDetail("BackendRooms", manifest);
    expect(detail.importPath).toBe("@threenative/backend");
    expect(detail.requires).toContain("npm i @threenative/backend");
    expect(detail.example).toContain("rooms.quickJoin");
  });

  it("points a networked-multiplayer request at the hosted rooms, not at a server to write", () => {
    const owned = loadCapabilityManifest(manifest);
    const row = owned.notOwned.find((entry) => entry.id === "networked-multiplayer");
    expect(row?.guidance).toContain("@threenative/backend");
    expect(row?.guidance).not.toMatch(/write .*server/iu);
  });
});
