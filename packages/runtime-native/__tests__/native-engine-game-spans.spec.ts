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

  it("wires TimestampQuery, setGpuTimer and completed GPU sample slots in web_host.cpp", () => {
    const webHost = readFileSync(
      path.resolve("packages/runtime-native/src/engine/wasm/web_host.cpp"),
      "utf8",
    );
    expect(webHost).toMatch(/for \(WGPUFeatureName feature : \{WGPUFeatureName_TimestampQuery,/u);
    expect(webHost).toMatch(
      /if \(wgpuAdapterHasFeature\(adapter, feature\)\) features\.push_back\(feature\);/u,
    );
    expect(webHost).toMatch(/desc\.requiredFeatureCount = features\.size\(\);/u);
    expect(webHost).toMatch(/desc\.requiredFeatures = features\.data\(\);/u);
    expect(webHost).toMatch(/renderer->setGpuTimer\(true\)/u);
    expect(webHost).toMatch(/case 7:\s*return renderer->lastGpuMs\(\);/u);
    expect(webHost).toMatch(/case 8:\s*return double\(renderer->gpuSamples\(\)\);/u);
    expect(webHost).toMatch(/case 9:\s*return double\(renderer->gpuSourceFrame\(\)\);/u);
    expect(webHost).toMatch(/case 10:\s*return renderer->gpuTimerEnabled\(\) \? 1 : 0;/u);
    expect(webHost).toMatch(/renderer->setGpuTimerSourceFrame\(sourceFrame\)/u);
    expect(webHost).toMatch(/int tnw_web_render\([^)]*uint32_t sourceFrame\)/u);
  });

  it("reports the submitted frame id, captured at submission, in renderer.cpp", () => {
    const renderer = readFileSync(
      path.resolve("packages/runtime-native/src/engine/renderer/renderer.cpp"),
      "utf8",
    );
    expect(renderer).toMatch(/job\.source = sourceFrame_;/u);
    expect(renderer).toMatch(/\[[^\]]*\bsource\b[^\]]*\][^\n]*\(GpuStatus status/u);
    expect(renderer).toMatch(/t->source = source;[^\n]*\n\s*\+\+t->samples;/u);
  });
});
