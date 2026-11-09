import * as THREE from "three";
import { describe, expect, it } from "vitest";

import catalogJson from "../api/catalog.json" with { type: "json" };
import registry from "../api/native-registry.json" with { type: "json" };
import { isTypeFlagField } from "../src/browser-backend.js";
import type { ICatalog, ICatalogClassEntry } from "../src/catalog.js";
import { defineObjectSurface, defineTypeFlags } from "../src/object-surface.js";

type Cls = new () => object;

/**
 * The flags a bound engine class carries on the web, set the way browser-backend.ts and
 * browser-entry.ts set them: catalog `is*` fields up the chain, the hand list, and the material base.
 */
function engineClasses(): Record<string, Cls> {
  const entries = new Map(
    (catalogJson as unknown as ICatalog).entries
      .filter((entry): entry is ICatalogClassEntry => entry.kind === "class")
      .map((entry) => [entry.name, entry]),
  );
  const classes: Record<string, Cls> = {};
  for (const name of Object.keys(registry.classes))
    classes[name] = { [name]: class {} }[name] as Cls;
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
  return classes;
}

/** Every `is*` flag three's own instance of the class reads true. */
function threeFlags(name: string): string[] | undefined {
  const Three = (THREE as unknown as Record<string, unknown>)[name];
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
    const classes = engineClasses();
    const missing: string[] = [];
    let compared = 0;
    for (const [name, cls] of Object.entries(classes)) {
      const flags = threeFlags(name);
      if (flags === undefined) continue;
      compared++;
      const engine = new cls() as Record<string, unknown>;
      const lacking = flags.filter((flag) => engine[flag] !== true);
      if (lacking.length > 0) missing.push(`${name}: ${lacking.join(", ")}`);
    }
    expect(compared).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});
