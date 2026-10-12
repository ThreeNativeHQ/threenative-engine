/**
 * PRD-531 phase 1: the catalog's supported set and the binding registry are one set.
 *
 * `native-registry.json` is the committed snapshot `tn-native-engine-registry-dump` prints, checked
 * for drift by the `native_engine_registry_snapshot` ctest. This spec compares it with the catalog:
 * every registry class is a supported catalog class and nothing else, and for each class the set of
 * bound member names equals the catalog's supported member names. A name on either side only fails
 * the test; an empty diff is the only pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type ICatalogClassEntry, loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const SNAPSHOT = path.join(REPO, "packages", "three-native", "api", "native-registry.json");

interface IRegistryClass {
  readonly constructor: boolean;
  readonly methods: readonly string[];
  readonly getters: readonly string[];
  readonly setters: readonly string[];
  readonly members: readonly string[];
  readonly callbacks: readonly string[];
}

interface IRegistryDump {
  readonly classes: Record<string, IRegistryClass>;
  readonly constants?: readonly string[];
}

/** A `__` member is engine-internal (a back end calls it, as `__walk`); three's surface never has it. */
const published = (member: string): boolean => !member.startsWith("__");

/** Top-level getters and member objects are catalog members; a dotted path is a protocol path. */
function registryMembers(binding: IRegistryClass): string[] {
  return [
    ...binding.methods.filter(published),
    ...binding.getters.filter((name) => !name.includes(".") && published(name)),
    ...binding.members.filter((name) => !name.includes(".") && published(name)),
    ...binding.callbacks,
  ];
}

function supportedMembers(
  entry: ICatalogClassEntry,
  byName: Map<string, ICatalogClassEntry>,
  seen = new Set<string>(),
): Set<string> {
  const names = new Set<string>();
  for (const member of [...entry.fields, ...entry.methods]) {
    const kind = member.status?.kind ?? entry.status.kind;
    if (kind === "supported") names.add(member.name);
  }
  const parent = entry.extends;
  const parentEntry = parent === null ? undefined : byName.get(parent);
  if (parentEntry !== undefined && !seen.has(parentEntry.name)) {
    seen.add(entry.name);
    for (const name of supportedMembers(parentEntry, byName, seen)) names.add(name);
  }
  return names;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("the catalog and the binding registry", () => {
  const dump = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as IRegistryDump;

  it("supports exactly the classes the registry binds", () => {
    const classes = loadCatalog(REPO).entries.filter(
      (entry): entry is ICatalogClassEntry => entry.kind === "class",
    );
    const supported = classes
      .filter((entry) => entry.status.kind === "supported")
      .map((entry) => entry.name);
    expect(sorted(supported)).toEqual(sorted(Object.keys(dump.classes)));
  });

  it("supports exactly the members the registry binds, per class", () => {
    const byName = new Map<string, ICatalogClassEntry>();
    for (const entry of loadCatalog(REPO).entries) {
      if (entry.kind === "class") byName.set(entry.name, entry);
    }
    for (const [name, binding] of Object.entries(dump.classes)) {
      const entry = byName.get(name);
      expect(entry, name).toBeDefined();
      if (entry === undefined) continue;
      const catalog = sorted(supportedMembers(entry, byName));
      const registry = sorted(registryMembers(binding));
      expect(catalog, name).toEqual(registry);
    }
  });

  it("publishes every supported class as a generated type id", () => {
    const table = readFileSync(
      path.join(REPO, "packages", "runtime-native", "src", "engine", "abi", "catalog_types.inc"),
      "utf8",
    );
    for (const name of Object.keys(dump.classes)) {
      expect(table, name).toContain(`TN_CATALOG_TYPE("${name}",`);
    }
    const names = [...table.matchAll(/TN_CATALOG_TYPE\("([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the supported constants are the registry's constants", () => {
    const constants = loadCatalog(REPO).entries.filter((entry) => entry.kind === "constant");
    const supported = constants
      .filter((entry) => entry.status.kind === "supported")
      .map((entry) => entry.name);
    expect(sorted(supported)).toEqual(sorted(dump.constants ?? []));
  });

  it("publishes DirectionalLight.target as assignable", () => {
    const light = loadCatalog(REPO).entries.find(
      (entry): entry is ICatalogClassEntry =>
        entry.kind === "class" && entry.name === "DirectionalLight",
    );
    expect(dump.classes.DirectionalLight?.setters).toContain("target");
    expect(light?.fields.find((field) => field.name === "target")?.mutable).toBe(true);
  });
});
