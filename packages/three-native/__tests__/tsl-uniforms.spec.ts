import { describe, expect, it } from "vitest";
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { liveUniforms } from "../src/tsl-uniforms.js";

describe("native TSL struct", () => {
  function fixture() {
    const calls: unknown[][] = [];
    const runtime: ITslRuntime = {
      call: (...args) => {
        calls.push(args);
        return calls.length;
      },
      release() {},
      set() {},
      setUniform() {},
      effectParameter: () => 0,
      setPost() {},
    };
    const exports = defineTsl(runtime).exports;
    return {
      calls,
      exports,
      struct: exports.struct as (
        layout: object,
        name?: string,
      ) => (...values: unknown[]) => { get(name: string): unknown },
    };
  }

  it("declares the layout through the native table and constructs named and positional members", () => {
    const f = fixture();
    const Sample = f.struct({ colour: "vec3", weight: "float" }, "Sample");
    expect(f.calls[0]).toEqual([
      "struct",
      null,
      [
        { kind: "string", text: "Sample" },
        { kind: "string", text: "colour" },
        { kind: "string", text: "vec3" },
        { kind: "string", text: "weight" },
        { kind: "string", text: "float" },
      ],
    ]);
    const colour = (f.exports.vec3 as (...values: number[]) => unknown)(1, 0, 0);
    Sample({ colour, weight: 0.5 }).get("colour");
    Sample(colour, 0.5).get("weight");
    expect(f.calls.map(([name]) => name)).toEqual([
      "struct",
      "vec3",
      "struct:new",
      "struct:get",
      "struct:new",
      "struct:get",
    ]);
    expect(f.calls[2]).toEqual([
      "struct:new",
      1,
      [
        { kind: "node", node: 2 },
        { kind: "number", number: 0.5 },
      ],
    ]);
  });

  it("rejects empty layouts and missing or extra values before crossing the ABI", () => {
    const f = fixture();
    expect(() => f.struct({})).toThrow("TN_TSL struct");
    const Sample = f.struct({ weight: "float" });
    expect(() => Sample({ typo: 1 })).toThrow("TN_TSL struct");
    expect(() => Sample(1, 2)).toThrow("TN_TSL struct");
    expect(() => Sample({ weight: 1, extra: 2 })).toThrow("TN_TSL struct");
  });
});

describe("liveUniforms", () => {
  it("runs onRenderUpdate on each sync and takes a returned value as the uniform's", () => {
    const written: number[][] = [];
    const live = liveUniforms(
      () => ({}),
      (_node, lanes) => written.push([...lanes]),
    );
    const node = live.uniform(1) as {
      value: number;
      onRenderUpdate(callback: () => unknown): object;
    };
    let calls = 0;
    expect(node.onRenderUpdate(() => (++calls === 1 ? 5 : undefined))).toBe(node);
    live.sync();
    expect(node.value).toBe(5);
    expect(written).toEqual([[5]]);
    live.sync();
    expect(calls).toBe(2);
    expect(node.value).toBe(5);
    expect(written).toEqual([[5]]);
  });

  it("gives uniformArray elements as live uniforms that follow in-place edits", () => {
    const written: number[][] = [];
    const live = liveUniforms(
      () => ({}),
      (_node, lanes) => written.push([...lanes]),
    );
    const wake = { x: 5, y: 6, z: 7, w: 8 };
    const ships = [{ x: 1, y: 2, z: 3, w: 4 }, wake];
    const array = live.uniformArray(ships);
    const second = array.element(1) as { value: unknown };
    expect(second.value).toBe(wake);
    wake.x = 50;
    live.sync();
    expect(written).toContainEqual([50, 6, 7, 8]);
    expect(() => array.element(2)).toThrow("TN_TSL_UNIFORM_ARRAY:");
    expect(() => array.element({})).toThrow("TN_TSL_UNIFORM_ARRAY:");
  });
});
