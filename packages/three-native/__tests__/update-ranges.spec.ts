import { describe, expect, it } from "vitest";

import { withUpdateRanges } from "../src/update-ranges.js";

/** An attribute stand-in with the engine's shape: a JSON getter plus add and clear. */
class FakeAttribute {
  reads = 0;
  clears = 0;
  adds = 0;
  ranges: { start: number; count: number }[] = [];
  get updateRanges(): string {
    this.reads += 1;
    return JSON.stringify(this.ranges);
  }
  addUpdateRange(start: number, count: number): this {
    this.adds += 1;
    this.ranges.push({ start, count });
    return this;
  }
  clearUpdateRanges(): this {
    this.clears += 1;
    this.ranges = [];
    return this;
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

it("clear then push performs one clear, one add and no JSON reads", () => {
  const attribute = new FakeAttribute();
  for (let frame = 0; frame < 3; frame += 1) {
    attribute.clearUpdateRanges();
    ranges(attribute).push({ start: frame, count: 16 });
  }
  expect([attribute.clears, attribute.adds, attribute.reads]).toEqual([3, 3, 0]);
  expect(attribute.ranges).toEqual([{ start: 2, count: 16 }]);
  // The upload consumes ranges without going through the JS wrapper.
  attribute.ranges = [];
  expect(ranges(attribute)).toHaveLength(0);
});

it("validates an entire push before adding any ranges", () => {
  const attribute = new FakeAttribute();
  attribute.clearUpdateRanges();
  expect(() => ranges(attribute).push({ start: 0, count: 1 }, { start: -1, count: 2 })).toThrow();
  expect(attribute.ranges).toEqual([]);
  expect(attribute.adds).toBe(0);
});

it("refreshes a saved push when a native upload consumed the previous ranges", () => {
  const attribute = new FakeAttribute();
  attribute.addUpdateRange(0, 4);
  const push = ranges(attribute).push;
  attribute.ranges = [];
  expect(push({ start: 8, count: 4 })).toBe(1);
  expect(attribute.ranges).toEqual([{ start: 8, count: 4 }]);
});

it("observes an add between clear and push", () => {
  const attribute = new FakeAttribute();
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, 4);
  expect(ranges(attribute).push({ start: 8, count: 4 })).toBe(2);
  expect(attribute.ranges).toEqual([
    { start: 0, count: 4 },
    { start: 8, count: 4 },
  ]);
});

it("preserves native add and clear return values", () => {
  const attribute = new FakeAttribute();
  expect(attribute.clearUpdateRanges()).toBe(attribute);
  expect(attribute.addUpdateRange(0, 4)).toBe(attribute);
});
