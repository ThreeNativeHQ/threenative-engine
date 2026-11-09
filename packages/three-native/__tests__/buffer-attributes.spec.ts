/**
 * PRD-784 P5-9: animation-composition's character builds `new Uint16BufferAttribute(indices, 4)`, which the
 * native profile did not bind. Each typed attribute converts its array and hands the engine three's
 * default `normalized = false`: the V8 engine's constructor refuses an explicit undefined argument.
 */
import { describe, expect, it } from "vitest";

import { defineTypedBufferAttribute } from "../src/buffer-attributes.js";

class StrictAttribute {
  readonly args: unknown[];
  constructor(...args: unknown[]) {
    if (args.includes(undefined)) throw new TypeError("TN_NATIVE_UNSUPPORTED expected a number");
    this.args = args;
  }
}

describe("typed BufferAttributes", () => {
  it("convert the array and pass three's normalized default", () => {
    for (const storage of [Uint8Array, Uint16Array, Uint32Array]) {
      const Typed = defineTypedBufferAttribute(StrictAttribute, storage);
      const [array, itemSize, normalized] = (new Typed([1, 2, 3, 4], 2) as StrictAttribute).args;
      expect(array).toBeInstanceOf(storage);
      expect(Array.from(array as ArrayLike<number>)).toEqual([1, 2, 3, 4]);
      expect([itemSize, normalized]).toEqual([2, false]);
      expect((new Typed([1], 1, true) as StrictAttribute).args[2]).toBe(true);
    }
  });
});
