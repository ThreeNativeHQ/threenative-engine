import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRD-806 E14: `verify-consumer.mjs` requires the cooked forest fixture — a missing fixture throws
 * "Missing cooked forest fixture" — so a flag re-tested after that throw guards arms that can never
 * run. The proof of the forest GLB must be unconditional.
 *
 * The mutation that reddens this file: declare `const flag = <existsSync(...)>`, throw on
 * `if (!flag)`, then write `if (flag) { ... }` or `flag ? ... : ...` below it.
 */
const script = path.resolve(import.meta.dirname, "../scripts/verify/verify-consumer.mjs");

describe("verify-consumer forest proof", () => {
  const source = readFileSync(script, "utf8");

  it("has no flag whose false arm its own throw already made unreachable", () => {
    expect(source).toMatch(/Missing cooked forest fixture/);
    const required = [...source.matchAll(/const (\w+) =[^;]*;\s*if \(!\1\)\s*throw/g)].map(
      (match) => match[1],
    );
    const reTested = required.filter((flag) =>
      new RegExp(`if \\(\\s*${flag}\\s*\\)|\\b${flag} \\?`).test(source),
    );
    expect(reTested).toEqual([]);
  });
});
