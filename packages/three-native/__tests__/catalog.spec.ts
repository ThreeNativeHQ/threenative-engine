import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CatalogEntry,
  type ICatalog,
  loadCatalog,
  readCatalogSchema,
  unsupportedSchemaKeywords,
  validateCatalog,
} from "../src/catalog.js";

/** The catalog lives in the repository, and vitest runs from its root. */
const REPO = process.cwd();

/** The catalog is readonly on purpose; a fixture that breaks one rule has to be mutable to do it. */
type Writable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? Writable<T[Key]> : T[Key];
};

function fixture(): Writable<ICatalog> {
  return JSON.parse(JSON.stringify(loadCatalog(REPO))) as Writable<ICatalog>;
}

function named(catalog: Writable<ICatalog>, name: string): Writable<CatalogEntry> {
  const found = catalog.entries.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`fixture is missing ${name}`);
  return found;
}

describe("the catalog schema", () => {
  it("accepts the committed catalog", () => {
    expect(validateCatalog(loadCatalog(REPO), readCatalogSchema(REPO))).toEqual([]);
  });

  it("uses no keyword the hand-written validator ignores", () => {
    expect(unsupportedSchemaKeywords(readCatalogSchema(REPO))).toEqual([]);
  });

  it("rejects an entry with no capability status", () => {
    const catalog = fixture();
    const vector = named(catalog, "Vector3");
    vector.status = undefined as unknown as Writable<typeof vector.status>;
    expect(validateCatalog(catalog, readCatalogSchema(REPO)).join("\n")).toMatch(
      /\$\.entries\[\d+\]\.status: missing required property kind/u,
    );
  });

  it("rejects a partial entry with no named gap and an unsupported entry with no diagnostic", () => {
    const schema = readCatalogSchema(REPO);
    const gaps = fixture();
    const partial = gaps.entries.find((candidate) => candidate.status.kind === "partial");
    if (partial === undefined) throw new Error("the catalog must publish a partial entry");
    partial.status = { kind: "partial", gaps: [] };
    expect(validateCatalog(gaps, schema).join("\n")).toContain("needs at least 1 items");

    const coded = fixture();
    const unsupported = coded.entries.find((candidate) => candidate.status.kind === "unsupported");
    if (unsupported === undefined) throw new Error("the catalog must publish an unsupported entry");
    unsupported.status = { kind: "unsupported", diagnostic: "not-a-code" };
    expect(validateCatalog(coded, schema).join("\n")).toContain("does not match ^TN_[A-Z0-9_]+$");
  });

  it("rejects an overload set with two identical parameter signatures", () => {
    const catalog = fixture();
    const vector = named(catalog, "Vector3");
    if (vector.kind !== "class") throw new Error("Vector3 must be a class entry");
    const set = vector.methods.find((method) => method.name === "add");
    if (set === undefined) throw new Error("Vector3.add must be published");
    set.overloads = [...set.overloads, JSON.parse(JSON.stringify(set.overloads[0]))];
    const errors = validateCatalog(catalog, readCatalogSchema(REPO));
    expect(errors.join("\n")).toContain(
      "Vector3].add: overload 2 repeats the parameter signature of overload 1",
    );
  });

  it("rejects a member naming a type the catalog does not publish", () => {
    const catalog = fixture();
    const vector = named(catalog, "Vector3");
    if (vector.kind !== "class") throw new Error("Vector3 must be a class entry");
    const field = vector.fields.find((candidate) => candidate.name === "x");
    if (field === undefined) throw new Error("Vector3.x must be published");
    field.type = "UnpublishedVector";
    expect(validateCatalog(catalog, readCatalogSchema(REPO)).join("\n")).toContain(
      'published type "UnpublishedVector" names UnpublishedVector',
    );
  });

  it("rejects a duplicate entry name", () => {
    const catalog = fixture();
    catalog.entries = [...catalog.entries, named(catalog, "Mesh")];
    expect(validateCatalog(catalog, readCatalogSchema(REPO))).toContain(
      "$.entries: duplicate entry Mesh",
    );
  });

  it("rejects a published constant whose value is not its declared type", () => {
    const catalog = fixture();
    const constant = named(catalog, "ACESFilmicToneMapping");
    catalog.entries = catalog.entries.map((entry) =>
      entry === constant ? { ...constant, value: "ACESFilmicToneMapping = 4" } : entry,
    );
    expect(validateCatalog(catalog, readCatalogSchema(REPO)).join("\n")).toContain(
      '$.entries[ACESFilmicToneMapping]: value "ACESFilmicToneMapping = 4" is not a number',
    );
  });
});

describe("the committed catalog", () => {
  it("covers every symbol the N00 inventory measured", () => {
    const inventory = JSON.parse(
      readFileSync(path.join(REPO, "docs/architecture/native-engine-inventory.json"), "utf8"),
    ) as { symbols: { imports: string[] } };
    const measured = new Set(inventory.symbols.imports.map((item) => item.split(":")[1] ?? ""));
    const catalog = loadCatalog(REPO);
    const missing = [...measured].filter(
      (name) => !catalog.entries.some((candidate) => candidate.name === name),
    );
    expect(missing).toEqual([]);
  });

  it("gives every unsupported entry a diagnostic code", () => {
    const unsupported = loadCatalog(REPO).entries.filter(
      (candidate) => candidate.status.kind === "unsupported",
    );
    expect(unsupported.length).toBeGreaterThan(0);
    for (const entry of unsupported) {
      if (entry.status.kind !== "unsupported") throw new Error("filtered to unsupported entries");
      expect(entry.status.diagnostic).toMatch(/^TN_NATIVE_UNSUPPORTED/u);
    }
  });
});
