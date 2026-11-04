// PRD-766 P1.3: an agent that has only the installed capability manifest finds the shore-wave bake
// by the symptom it is asked to fix — "the waves do not break on the beach" — rather than by the
// name of a spatial algorithm it could not have guessed.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityDetail, searchCapabilities } from "../src/index.js";

const manifest = path.resolve("packages/create-threenative/capabilities.json");

describe("shore wave discovery", () => {
  it("answers the symptom with the bake, first", () => {
    for (const [query, scope] of [
      ["waves break on a beach", "request"],
      ["waves break on a beach", "mechanic"],
      ["surf and breakers on a shoreline", "mechanic"],
      ["ocean waves breaking on the shore", "request"],
      ["why do my waves not break on the beach", "request"],
    ] as const) {
      const response = searchCapabilities(query, manifest, scope);
      expect(response.verdict, query).toBe("matched");
      expect(
        response.results[0]?.symbol,
        `${scope} "${query}" returned ${response.results.map((r) => r.symbol).join(", ")}`,
      ).toBe("bakeShoreWaves");
      expect(response.results[0]?.importPath).toBe("@threenative/core");
    }
  });

  it("states the fields, the reach and the limits it cannot exceed", () => {
    const detail = JSON.stringify(capabilityDetail("bakeShoreWaves", manifest));
    expect(detail).toContain("travel time");
    expect(detail).toContain("Infinity");
    expect(detail).toContain("open-sea rim");
    expect(detail).toContain("0.42");
    expect(detail).toContain("decides no colour");
  });
});
