import { describe, expect, it } from "vitest";
import { createTweakBox } from "../src/editor/tweak-box.js";

const knobs = {
  sun: { value: 20, min: 5, max: 60, step: 1 },
  mist: { color: 0x6c8590 },
} as const;

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("createTweakBox", () => {
  it("applies each default once, with no page to draw on", () => {
    const seen: [string, number][] = [];
    const box = createTweakBox({
      title: "wood",
      knobs,
      onChange: (name, value) => seen.push([name, value]),
      host: {},
    });
    expect(seen).toEqual([
      ["sun", 20],
      ["mist", 0x6c8590],
    ]);
    expect(JSON.parse(box.snapshot())).toEqual({
      tweaks: "wood",
      values: { sun: 20, mist: "#6c8590" },
    });
  });

  it("stores a change, restores it on the next box, and resets to the spec", () => {
    const storage = store();
    const first = createTweakBox({
      title: "wood",
      knobs,
      onChange: () => {},
      storageKey: "k",
      host: { storage },
    });
    first.set("sun", 31.4);
    first.set("mist", 0x102030);
    const seen: Record<string, number> = {};
    const second = createTweakBox({
      title: "wood",
      knobs,
      onChange: (name, value) => {
        seen[name] = value;
      },
      storageKey: "k",
      host: { storage },
    });
    expect(seen).toEqual({ sun: 31.4, mist: 0x102030 });
    // The snapshot rounds to the knob's step.
    expect(JSON.parse(second.snapshot()).values).toEqual({ sun: 31, mist: "#102030" });
    second.reset();
    expect(second.values).toEqual({ sun: 20, mist: 0x6c8590 });
    expect(storage.data.has("k")).toBe(false);
  });

  it("drops a stored value that today's range refuses, and throws on a refused set", () => {
    const storage = store({ k: JSON.stringify({ sun: 900, mist: "red", gone: 1 }) });
    const box = createTweakBox({
      title: "wood",
      knobs,
      onChange: () => {},
      storageKey: "k",
      host: { storage },
    });
    expect(box.values).toEqual({ sun: 20, mist: 0x6c8590 });
    expect(() => box.set("sun", 61)).toThrow("out of range");
    expect(() => box.set("mist", 0x1000000)).toThrow("out of range");
  });

  it("refuses a knob whose default lies outside its own range", () => {
    expect(() =>
      createTweakBox({
        title: "x",
        knobs: { a: { value: 9, min: 0, max: 1 } },
        onChange: () => {},
        host: {},
      }),
    ).toThrow("default out of range");
  });
});
