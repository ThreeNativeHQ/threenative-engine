import { describe, expect, it } from "vitest";

import { decimalOf, loadFixtures, pinnedThreeVersion, readGolden } from "../src/fixture-format.js";
import { decodeNumbers } from "../src/fixture-protocol.js";

const VERSION = pinnedThreeVersion();

// BUG-run-reference-euler: Euler.toArray() is [x, y, z, order]. The old encoder coerced the order
// string to NaN bits, so goldens pinned a NaN while their decimal said "YZX". The reference runner
// is not in CI; this node-only check keeps every pinned number honest about what three returned.
describe("pinned goldens", () => {
  it("record every number as the bits its decimal names", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const fixture of loadFixtures()) {
      for (const observation of readGolden(fixture.name, VERSION)?.observations ?? []) {
        if (observation.kind !== "number" && observation.kind !== "numbers") continue;
        checked += 1;
        const decimal = decodeNumbers(observation.value).map(decimalOf).join(", ");
        if (decimal !== observation.decimal)
          mismatches.push(
            `${fixture.name}#${observation.index}: ${observation.decimal} != ${decimal}`,
          );
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});
