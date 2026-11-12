import { describe, expect, it } from "vitest";
import { CORE_TEMPLATE_FLOOR, pairsWithCore } from "../src/core-pair.js";
import { CORE_PACKAGE_VERSION } from "../src/mcp-servers.js";

const [MAJOR, MINOR, PATCH] = CORE_PACKAGE_VERSION.split(".").map(Number) as [
  number,
  number,
  number,
];

function previousRelease(): string {
  if (PATCH > 0) return `${MAJOR}.${MINOR}.${PATCH - 1}`;
  if (MINOR > 0) return `${MAJOR}.${MINOR - 1}.99`;
  return `${MAJOR - 1}.99.99`;
}

describe("the core a game may pair with", () => {
  it("ships the same floor the templates declare", () => {
    expect(CORE_TEMPLATE_FLOOR).toBe(`>=${CORE_PACKAGE_VERSION}`);
  });

  it("accepts the release this create-threenative was built against", () => {
    expect(pairsWithCore(CORE_PACKAGE_VERSION)).toBe(true);
  });

  it("accepts anything newer, because a template resolves the newest published engine", () => {
    expect(pairsWithCore(`${MAJOR}.${MINOR}.${PATCH + 1}`)).toBe(true);
    expect(pairsWithCore(`${MAJOR}.${MINOR + 1}.0`)).toBe(true);
    expect(pairsWithCore(`${MAJOR + 1}.0.0`)).toBe(true);
  });

  it("refuses an install older than the paired release", () => {
    expect(pairsWithCore(previousRelease())).toBe(false);
    expect(pairsWithCore(`${MAJOR}.0.0`) && MAJOR === 0).toBe(false);
  });

  it("refuses an install it cannot read", () => {
    expect(pairsWithCore(undefined)).toBe(false);
    expect(pairsWithCore("not-a-version")).toBe(false);
    expect(pairsWithCore("")).toBe(false);
  });
});
