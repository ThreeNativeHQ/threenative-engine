import { describe, expect, it } from "vitest";

import { withUpdateRanges } from "../src/update-ranges.js";

/** An attribute stand-in with the engine's shape: a JSON getter plus add and clear. */
class FakeAttribute {
  ranges: { start: number; count: number }[] = [];
  get updateRanges(): string {
    return JSON.stringify(this.ranges);
  }
  addUpdateRange(start: number, count: number): void {
    this.ranges.push({ start, count });
  }
  clearUpdateRanges(): void {
    this.ranges = [];
  }
}
withUpdateRanges(FakeAttribute.prototype);
const ranges = (attribute: FakeAttribute) =>
  attribute.updateRanges as unknown as { start: number; count: number }[];

describe("updateRanges on the web facade", () => {
  it("reads the engine's records as an array", () => {
    const attribute = new FakeAttribute();
    attribute.addUpdateRange(2, 5);
    expect(ranges(attribute)).toEqual([{ start: 2, count: 5 }]);
    expect(ranges(attribute).length).toBe(1);
  });

  it("writes push back to the engine, spreading another attribute's ranges", () => {
    const source = new FakeAttribute();
    source.addUpdateRange(0, 16);
    source.addUpdateRange(32, 16);
    const derived = new FakeAttribute();
    ranges(derived).push(...ranges(source));
    expect(derived.ranges).toEqual([
      { start: 0, count: 16 },
      { start: 32, count: 16 },
    ]);
  });

  it("writes splice and index writes back, and refuses a record that is not a count", () => {
    const attribute = new FakeAttribute();
    attribute.addUpdateRange(0, 4);
    attribute.addUpdateRange(8, 4);
    ranges(attribute).splice(0, 1);
    expect(attribute.ranges).toEqual([{ start: 8, count: 4 }]);
    expect(() => ranges(attribute).push({ start: -1, count: 2 })).toThrow(/TN_NATIVE_UNSUPPORTED/u);
    expect(attribute.ranges).toEqual([{ start: 8, count: 4 }]);
  });

  it("follows a clear the engine made", () => {
    const attribute = new FakeAttribute();
    attribute.addUpdateRange(0, 4);
    expect(ranges(attribute)).toHaveLength(1);
    attribute.clearUpdateRanges();
    expect(ranges(attribute)).toHaveLength(0);
  });
});
