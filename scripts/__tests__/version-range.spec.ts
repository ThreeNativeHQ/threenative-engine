import { describe, expect, it } from "vitest";
import {
  rangeFloor,
  rangeForVersion,
  satisfiesSpecifier,
  templateSpecifier,
} from "../version-range.js";

describe("template version floors", () => {
  it("turns a workspace version into an open floor", () => {
    expect(rangeForVersion("0.3.13")).toBe(">=0.3.13");
    expect(rangeForVersion("1.4.2")).toBe(">=1.4.2");
  });

  it("floats our packages and pins the tool", () => {
    expect(templateSpecifier("@threenative/core", "0.3.13")).toBe(">=0.3.13");
    expect(templateSpecifier("@threenative/runtime-native", "0.3.13")).toBe(">=0.3.13");
    expect(templateSpecifier("create-threenative", "0.2.18")).toBe("0.2.18");
    expect(templateSpecifier("threenative-engine-mcp", "0.4.0")).toBe("0.4.0");
  });

  it("reads the floor back out", () => {
    expect(rangeFloor(">=0.3.13")).toBe("0.3.13");
    expect(rangeFloor("0.3.13")).toBeUndefined();
    expect(rangeFloor("^0.3.13")).toBeUndefined();
  });

  it("admits every newer release, including a later major, and refuses an older one", () => {
    expect(satisfiesSpecifier("0.3.13", ">=0.3.13")).toBe(true);
    expect(satisfiesSpecifier("0.3.99", ">=0.3.13")).toBe(true);
    expect(satisfiesSpecifier("0.4.0", ">=0.3.13")).toBe(true);
    expect(satisfiesSpecifier("1.0.0", ">=0.3.13")).toBe(true);
    expect(satisfiesSpecifier("0.3.12", ">=0.3.13")).toBe(false);
    expect(satisfiesSpecifier("0.2.99", ">=0.3.13")).toBe(false);
  });

  it("still compares an exact pin exactly", () => {
    expect(satisfiesSpecifier("0.2.18", "0.2.18")).toBe(true);
    expect(satisfiesSpecifier("0.2.19", "0.2.18")).toBe(false);
  });

  it("refuses a version it cannot read instead of passing it", () => {
    expect(() => rangeForVersion("0.3")).toThrow(/TN_VERSION_RANGE/u);
    expect(satisfiesSpecifier("0.3.13", ">=0.3")).toBe(false);
  });
});
