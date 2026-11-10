import * as THREE from "three";
import * as WEBGPU from "three/webgpu";
import { describe, expect, it } from "vitest";

import catalogJson from "../api/catalog.json" with { type: "json" };
import registry from "../api/native-registry.json" with { type: "json" };
import { defineBox2 } from "../src/box2.js";
import { isTypeFlagField } from "../src/browser-backend.js";
import { defineTypedBufferAttribute } from "../src/buffer-attributes.js";
import type { ICatalog, ICatalogClassEntry } from "../src/catalog.js";
import { defineEdgesGeometry } from "../src/edges-geometry.js";
import { defineGridHelper } from "../src/grid-helper.js";
import { defineObjectSurface, defineTypeFlags } from "../src/object-surface.js";
import { defineQuadMesh } from "../src/quad-mesh.js";
import { defineLayeredTargets } from "../src/render-target.js";

type Cls = new () => object;

/** Answers every read, call and construction with itself, so a JS port's constructor runs over a fake engine. */
const anything: unknown = new Proxy(() => {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : anything),
  apply: () => anything,
  construct: () => anything as object,
});

/**
 * The engine classes the web module exports, with their flags set the way browser-backend.ts and
 * browser-entry.ts set them: catalog `is*` fields up the chain, the hand list, the material base,
 * and the JS ports built over the engine classes.
 */
function engineClasses(): Record<string, Cls> {
  const entries = new Map(
    (catalogJson as unknown as ICatalog).entries
      .filter((entry): entry is ICatalogClassEntry => entry.kind === "class")
      .map((entry) => [entry.name, entry]),
  );
  const classes: Record<string, Cls> = {};
  for (const name of Object.keys(registry.classes))
    classes[name] = {
      [name]: class {
        constructor() {
          // A member the engine binds and this fake lacks reads as `anything`, never as a flag.
          // biome-ignore lint/correctness/noConstructorReturn: the fake stands in for every engine member.
          return new Proxy(this, {
            get: (target, key, receiver) =>
              key in target ? Reflect.get(target, key, receiver) : anything,
          });
        }
      },
    }[name] as Cls;
  for (const [name, cls] of Object.entries(classes)) {
    const entry = entries.get(name);
    const parent = entry?.extends ? classes[entry.extends] : undefined;
    if (parent !== undefined) Object.setPrototypeOf(cls.prototype, parent.prototype);
    for (let link = entry; link; link = link.extends ? entries.get(link.extends) : undefined)
      for (const field of link.fields.filter(isTypeFlagField))
        Object.defineProperty(cls.prototype, field.name, { configurable: true, value: true });
  }
  defineTypeFlags(classes);
  defineObjectSurface({
    bufferGeometry: classes.BufferGeometry ?? class {},
    geometries: [],
    materials: Object.keys(classes)
      .filter((name) => entries.get(name)?.extends === "Material")
      .map((name) => classes[name] as Cls),
  });
  const engine = classes as never;
  return {
    ...classes,
    ...(defineLayeredTargets(engine) as unknown as Record<string, Cls>),
    QuadMesh: defineQuadMesh(engine) as unknown as Cls,
    GridHelper: defineGridHelper(engine) as unknown as Cls,
    EdgesGeometry: defineEdgesGeometry(engine) as unknown as Cls,
    Box2: defineBox2(engine) as unknown as Cls,
    Uint8BufferAttribute: defineTypedBufferAttribute(
      classes.BufferAttribute as never,
      Uint8Array,
    ) as unknown as Cls,
  };
}

/** Every `is*` flag three's own instance of the class reads true, from `three` or `three/webgpu`. */
function threeFlags(name: string): string[] | undefined {
  const Three =
    (THREE as unknown as Record<string, unknown>)[name] ??
    (WEBGPU as unknown as Record<string, unknown>)[name];
  if (typeof Three !== "function") return undefined;
  let instance: Record<string, unknown>;
  try {
    instance = new (Three as new () => Record<string, unknown>)();
  } catch {
    return undefined;
  }
  const keys = new Set<string>();
  for (let link: object | null = instance; link !== null; link = Object.getPrototypeOf(link))
    for (const key of Object.getOwnPropertyNames(link)) keys.add(key);
  return [...keys].filter((key) => /^is[A-Z]/u.test(key) && instance[key] === true).sort();
}

describe("owned-engine type flags", () => {
  it("carry every is* flag three sets, so game code that branches on one takes the same path", () => {
    // Midway's particle batch re-sent only `isInstancedBufferAttribute` attributes; the flag was
    // missing, so smoke and fire never left their creation zeros (PRD-860). A flag three sets and
    // the engine class lacks reads undefined and silently skips the game's branch.
    const missing: string[] = [];
    const unchecked: string[] = [];
    let compared = 0;
    for (const [name, cls] of Object.entries(engineClasses())) {
      const flags = threeFlags(name);
      if (flags === undefined) continue;
      let engine: Record<string, unknown>;
      try {
        engine = new cls() as Record<string, unknown>;
      } catch {
        unchecked.push(name);
        continue;
      }
      compared++;
      const lacking = flags.filter((flag) => engine[flag] !== true);
      if (lacking.length > 0) missing.push(`${name}: ${lacking.join(", ")}`);
    }
    expect(missing).toEqual([]);
    // A class this check cannot build is a class it cannot guard: name it here instead of skipping it.
    expect(unchecked).toEqual([]);
    expect(compared).toBeGreaterThan(60);
  });
});
