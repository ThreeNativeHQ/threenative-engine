/**
 * PRD-784 P5-9: probe-volume builds `new Box2(new Vector2(0, 0), new Vector2(9, 1))`, which the native
 * profile did not bind. The port against three's own Box2, both over the pinned three's Vector2.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { defineBox2 } from "../src/box2.js";

// biome-ignore lint/suspicious/noExplicitAny: upstream three's own classes, untyped here.
type Loose = any;
const fromCore = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);
const Port: Loose = defineBox2(T);

const v = (x: number, y: number) => new T.Vector2(x, y);
const box = (Box: Loose) => new Box().setFromPoints([v(1, 2), v(-3, 4), v(2, -1)]);
const read = (b: Loose) => [b.min.x, b.min.y, b.max.x, b.max.y];

describe("Box2 port", () => {
  it("matches three for setFromPoints, containsPoint, intersectsBox and union", () => {
    for (const Box of [T.Box2, Port]) {
      const a = box(Box);
      expect(read(a)).toEqual([-3, -1, 2, 4]);
      expect([a.containsPoint(v(0, 0)), a.containsPoint(v(5, 0))]).toEqual([true, false]);
      const far = new Box(v(10, 10), v(11, 11));
      const touching = new Box(v(2, 4), v(6, 6));
      expect([a.intersectsBox(far), a.intersectsBox(touching)]).toEqual([false, true]);
      expect(read(a.clone().union(far))).toEqual([-3, -1, 11, 11]);
    }
  });

  it("matches three for every other method", () => {
    const results = [T.Box2, Port].map((Box) => {
      const a = box(Box);
      const empty = new Box();
      return [
        empty.isEmpty(),
        a.isEmpty(),
        a.getCenter(v(0, 0)).toArray(),
        a.getSize(v(0, 0)).toArray(),
        empty.getSize(v(9, 9)).toArray(),
        a.containsBox(new Box(v(0, 0), v(1, 1))),
        a.getParameter(v(0, 0), v(0, 0)).toArray(),
        a.clampPoint(v(9, -9), v(0, 0)).toArray(),
        a.distanceToPoint(v(5, 4)),
        read(a.clone().intersect(new Box(v(0, 0), v(9, 9)))),
        a
          .clone()
          .intersect(new Box(v(10, 10), v(11, 11)))
          .isEmpty(),
        read(a.clone().expandByScalar(1)),
        read(a.clone().expandByVector(v(1, 2))),
        read(a.clone().translate(v(1, 1))),
        read(new Box().setFromCenterAndSize(v(1, 1), v(2, 4))),
        a.equals(a.clone()),
        a.isBox2,
      ];
    });
    expect(results[1]).toEqual(results[0]);
  });
});
