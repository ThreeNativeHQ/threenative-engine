/**
 * PRD-784 P5-9: prd476-fluid-particles draws `new EdgesGeometry(new BoxGeometry(...))`, which the
 * native profile did not bind. The port against three's own EdgesGeometry, both over the pinned three's
 * classes: the same edge vertices for an indexed box, a non-indexed sphere and a 15 degree threshold.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { defineEdgesGeometry } from "../src/edges-geometry.js";

// Upstream three's own classes, untyped here: "three" maps to the engine's declarations.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);
const Port: Loose = defineEdgesGeometry(T);

const positions = (geometry: Loose) => Array.from(geometry.getAttribute("position").array);

describe("EdgesGeometry port", () => {
  it("gives a box its 12 edges, as three does", () => {
    const box = new T.BoxGeometry(1, 2, 3);
    const edges = new Port(box);
    expect(edges.getAttribute("position").count).toBe(24);
    expect(positions(edges)).toEqual(positions(new T.EdgesGeometry(box)));
    expect(edges.type).toBe("EdgesGeometry");
    expect(edges.parameters).toEqual({ geometry: box, thresholdAngle: 1 });
  });

  it("matches three on a non-indexed sphere and at a wider threshold", () => {
    const sphere = new T.SphereGeometry(1, 8, 6).toNonIndexed();
    for (const angle of [1, 15]) {
      const expected = positions(new T.EdgesGeometry(sphere, angle));
      expect(expected.length).toBeGreaterThan(0);
      expect(positions(new Port(sphere, angle))).toEqual(expected);
    }
  });

  it("has no position attribute without a source geometry", () => {
    expect(new Port().getAttribute("position")).toBeUndefined();
  });
});
