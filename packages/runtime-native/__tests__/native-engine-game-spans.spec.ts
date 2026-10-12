import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GAME_SPANS, SPANS, SPAN_NAMES } from "../../core/src/profiling/Spans.js";

/**
 * The engine player names a span by its position in `kGameSpanNames` (run.cpp), and core hands it
 * ids from two tables: SPANS for the render phases and GAME_SPANS for the game's. A render span
 * added to core moves every game id, so a drift here would label one span with another's name.
 */
const source = readFileSync(
  path.resolve("packages/runtime-native/src/engine/player/run.cpp"),
  "utf8",
);
const table = /kGameSpanNames\[\] = \{([^}]*)\}/u.exec(source)?.[1] ?? "";
const names = [...table.matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1] as string);

describe("native engine game spans", () => {
  it("names every render span at core's id", () => {
    expect(names.slice(0, SPAN_NAMES.length)).toEqual([...SPAN_NAMES]);
  });

  it("names every game span at core's id", () => {
    for (const [name, id] of Object.entries(GAME_SPANS)) expect(names[id]).toBe(name);
  });

  it("keeps the render and game ids disjoint", () => {
    const render = new Set<number>(Object.values(SPANS));
    for (const id of Object.values(GAME_SPANS)) expect(render.has(id)).toBe(false);
  });

  it("opens the host spans at the ids run.cpp names", () => {
    const constant = (name: string): number =>
      Number(new RegExp(`${name} = (\\d+);`, "u").exec(source)?.[1]);
    expect(names[constant("kHostUpdateSpan")]).toBe("hostUpdate");
    expect(names[constant("kHostFrameSpan")]).toBe("hostFrame");
    expect(names[constant("kGcSpan")]).toBe("gc");
  });
});
