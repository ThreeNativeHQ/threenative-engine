/**
 * three's PropertyBinding facade over the engine's: a game binds every track of every clip while it
 * loads, so a track costs one engine call to bind and read its target, and a path parses once.
 */

import { describe, expect, it } from "vitest";

import { definePropertyBinding } from "../src/property-binding.js";

function engineClass(calls: string[]) {
  const hip = { name: "hip" };
  class Native {
    constructor(
      readonly root?: unknown,
      readonly path?: string,
    ) {}
    bind() {
      calls.push("bind");
      return this.path === "leg.position" ? "No target node found" : "";
    }
    __bind() {
      calls.push("__bind");
      const missing = this.path === "leg.position";
      return [missing ? "No target node found" : "", missing ? null : hip];
    }
    targetObject() {
      calls.push("targetObject");
      return this.path === "leg.position" ? null : hip;
    }
    unbind() {
      calls.push("unbind");
    }
    parseTrackName(path: string) {
      calls.push("parseTrackName");
      return { nodeName: path.split(".")[0], propertyName: path.split(".")[1] };
    }
    findNode() {
      calls.push("findNode");
      return null;
    }
  }
  return { Native: Native as never, hip };
}

describe("PropertyBinding facade", () => {
  it("binds and reads the target in one engine call, and parses a path once", () => {
    const calls: string[] = [];
    const { Native, hip } = engineClass(calls);
    const { PropertyBinding, setConsoleFunction } = definePropertyBinding(Native);
    const reasons: string[] = [];
    setConsoleFunction((_type, message) => reasons.push(message));
    const Binding = PropertyBinding as unknown as new (
      root: unknown,
      path: string,
    ) => { bind(): void; unbind(): void; targetObject: unknown };
    const parse = (PropertyBinding as unknown as { parseTrackName(p: string): object })
      .parseTrackName;

    const bound = new Binding({}, "hip.position");
    bound.bind();
    expect(bound.targetObject).toBe(hip);
    const missing = new Binding({}, "leg.position");
    missing.bind();
    expect(missing.targetObject).toBeNull();
    expect(reasons).toEqual(["No target node found"]);
    expect(calls.filter((call) => call !== "bind")).toEqual(["__bind", "__bind"]);

    const first = parse("hip.position") as Record<string, unknown>;
    first.nodeName = "changed";
    expect(parse("hip.position")).toEqual({ nodeName: "hip", propertyName: "position" });
    expect(calls.filter((call) => call === "parseTrackName")).toHaveLength(1);

    bound.unbind();
    expect(bound.targetObject).toBe(hip);
    expect(calls.at(-1)).toBe("targetObject");
  });
});
