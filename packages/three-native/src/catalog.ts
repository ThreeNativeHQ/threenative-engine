import { readFileSync } from "node:fs";
import path from "node:path";

export type CatalogStatus =
  | { readonly kind: "supported" }
  | { readonly kind: "partial"; readonly gaps: readonly string[] }
  | { readonly kind: "unsupported"; readonly diagnostic: string };

export interface ICatalogParameter {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly default?: string;
  readonly callback?: string;
  readonly rest?: boolean;
}

export interface ICatalogOverload {
  readonly parameters: readonly ICatalogParameter[];
  readonly returns: string;
}

export interface ICatalogField {
  readonly name: string;
  readonly type: string;
  readonly mutable: boolean;
  readonly lifetime: "owned" | "reference";
  readonly accessor?: boolean;
  readonly default?: string;
  readonly note?: string;
  readonly status?: CatalogStatus;
}

export interface ICatalogMethod {
  readonly name: string;
  readonly async: boolean;
  readonly overloads: readonly ICatalogOverload[];
  readonly note?: string;
  readonly status?: CatalogStatus;
}

export interface ICatalogEntryBase {
  readonly name: string;
  readonly source: string;
  readonly status: CatalogStatus;
}

export interface ICatalogClassEntry extends ICatalogEntryBase {
  readonly kind: "class";
  readonly extends: string | null;
  readonly constructor: readonly ICatalogParameter[];
  readonly fields: readonly ICatalogField[];
  readonly methods: readonly ICatalogMethod[];
}

export interface ICatalogTypeEntry extends ICatalogEntryBase {
  readonly kind: "type";
  readonly type: string;
}

export interface ICatalogEnumEntry extends ICatalogEntryBase {
  readonly kind: "enum";
  readonly values: readonly { readonly name: string; readonly value: string | number }[];
}

export interface ICatalogConstantEntry extends ICatalogEntryBase {
  readonly kind: "constant";
  readonly type: "number" | "string";
  readonly value: string | number;
}

export interface ICatalogFunctionEntry extends ICatalogEntryBase {
  readonly kind: "function";
  readonly parameters?: readonly ICatalogParameter[];
  readonly returns?: string;
}

export type CatalogEntry =
  | ICatalogClassEntry
  | ICatalogTypeEntry
  | ICatalogEnumEntry
  | ICatalogConstantEntry
  | ICatalogFunctionEntry;

export interface ICatalog {
  readonly version: 1;
  readonly reference: { readonly three: string; readonly types: string; readonly patch: string };
  readonly abi: {
    readonly engine: number;
    readonly compatibilityContract: number;
    readonly scene: number;
    readonly shaderPackage: number;
  };
  readonly entries: readonly CatalogEntry[];
}

/** TypeScript names a catalog type may use without being a catalog entry of its own. */
const TYPESCRIPT_NAMES: ReadonlySet<string> = new Set([
  "Array",
  "ArrayBuffer",
  "ArrayBufferLike",
  "ArrayBufferView",
  "ArrayLike",
  "BigInt",
  "Boolean",
  "Date",
  "Exclude",
  "Extract",
  "Float32Array",
  "Float64Array",
  "Function",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Map",
  "NoInfer",
  "NonNullable",
  "Number",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "PromiseLike",
  "Readonly",
  "ReadonlyArray",
  "Record",
  "Set",
  "String",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "any",
  "boolean",
  "false",
  "keyof",
  "never",
  "null",
  "number",
  "object",
  "readonly",
  "self",
  "string",
  "this",
  "true",
  "undefined",
  "unknown",
  "void",
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "object") return actual === "object";
  return actual === expected;
}

/** JSON Schema keywords the catalog schema uses. Anything else in a schema is not supported. */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "const",
  "default",
  "description",
  "enum",
  "items",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

function resolveRef(schema: Record<string, unknown>, root: Record<string, unknown>): unknown {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const key of reference.slice(2).split("/")) {
    value = record(value)[key];
  }
  return value;
}

/** Walks the schema subset `catalog.schema.json` uses and collects every disagreement. */
export function schemaErrors(
  value: unknown,
  schema: unknown,
  path = "$",
  root: unknown = schema,
): readonly string[] {
  if (typeof schema !== "object" || schema === null) return [`${path}: schema is not an object`];
  const node = record(schema);
  const target = node.$ref === undefined ? node : record(resolveRef(node, record(root)));
  const errors: string[] = [];
  if (target !== node && Object.keys(target).length === 0)
    return [`${path}: unresolved $ref ${String(node.$ref)}`];
  if (node.$ref !== undefined && target !== node) return schemaErrors(value, target, path, root);

  if (target.const !== undefined && JSON.stringify(value) !== JSON.stringify(target.const))
    errors.push(
      `${path}: expected ${JSON.stringify(target.const)}, found ${JSON.stringify(value)}`,
    );
  if (Array.isArray(target.enum) && !target.enum.some((option) => option === value))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(target.enum)}`);
  if (typeof target.type === "string" && !matchesType(value, target.type))
    errors.push(`${path}: expected ${target.type}, found ${typeOf(value)}`);
  if (Array.isArray(target.type) && !target.type.some((option) => matchesType(value, option)))
    errors.push(`${path}: expected one of ${target.type.join("|")}, found ${typeOf(value)}`);
  if (typeof value === "string") {
    if (typeof target.pattern === "string" && !new RegExp(target.pattern, "u").test(value))
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${target.pattern}`);
    if (typeof target.minLength === "number" && value.length < target.minLength)
      errors.push(`${path}: shorter than ${target.minLength}`);
  }
  if (typeof value === "number" && typeof target.minimum === "number" && value < target.minimum)
    errors.push(`${path}: below minimum ${target.minimum}`);

  if (Array.isArray(target.oneOf)) {
    const branches = target.oneOf.map((branch) => schemaErrors(value, branch, path, root));
    const passing = branches.filter((branch) => branch.length === 0).length;
    if (passing === 0) {
      // Report the branch the value came closest to matching, so the message names the real
      // disagreement instead of the first branch's.
      const closest = [...branches].sort((left, right) => left.length - right.length)[0];
      errors.push(...(closest ?? [`${path}: matches no schema branch`]));
    } else if (passing > 1) errors.push(`${path}: matches ${passing} schema branches`);
  }

  const actual = record(value);
  const properties = record(target.properties);
  for (const key of (Array.isArray(target.required) ? target.required : []) as string[]) {
    // `in` would be satisfied by Object.prototype for a key named `constructor`.
    if (!Object.hasOwn(actual, key)) errors.push(`${path}: missing required property ${key}`);
  }
  if (target.additionalProperties === false) {
    for (const key of Object.keys(actual)) {
      if (!(key in properties)) errors.push(`${path}: unexpected property ${key}`);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(actual, key))
      errors.push(...schemaErrors(actual[key], child, `${path}.${key}`, root));
  }

  if (Array.isArray(value)) {
    if (typeof target.minItems === "number" && value.length < target.minItems)
      errors.push(`${path}: needs at least ${target.minItems} items, found ${value.length}`);
    if (target.items !== undefined) {
      value.forEach((item, index) =>
        errors.push(...schemaErrors(item, target.items, `${path}[${index}]`, root)),
      );
    }
  }
  return errors;
}

/** The parameter signature that makes an overload ambiguous: same names, same types, same shape. */
function overloadSignature(overload: ICatalogOverload): string {
  return overload.parameters
    .map(
      (parameter) => `${parameter.rest === true ? "..." : ""}${parameter.name}:${parameter.type}`,
    )
    .join(", ");
}

function typeNames(text: string): readonly string[] {
  const withoutLiterals = text.replace(/'[^']*'/gu, "''").replace(/"[^"]*"/gu, '""');
  // Object literals, index signatures and a callback's own parameter list name no type.
  const withoutBlocks = withoutLiterals
    .replace(/\{[^{}]*\}/gu, " ")
    .replace(/\[[^\[\]]*\]/gu, " ")
    .replace(/\([^()]*\)/gu, " ");
  return [...new Set(withoutBlocks.match(/[A-Za-z_$][\w$]*/gu) ?? [])];
}

function memberTypes(entry: ICatalogClassEntry): readonly string[] {
  return [
    ...(entry.extends === null ? [] : [entry.extends]),
    ...entry.constructor.map((parameter) => parameter.type),
    ...entry.fields
      .filter((field) => field.status?.kind !== "unsupported")
      .map((field) => field.type),
    ...entry.methods
      .filter((method) => method.status?.kind !== "unsupported")
      .flatMap((method) =>
        method.overloads.flatMap((overload) => [
          overload.returns,
          ...overload.parameters.map((parameter) => parameter.type),
        ]),
      ),
  ];
}

/** Rules the schema cannot express: one name per symbol, no ambiguous overloads, resolvable types. */
export function semanticErrors(catalog: ICatalog): readonly string[] {
  const errors: string[] = [];
  const byName = new Map<string, CatalogEntry>();
  for (const entry of catalog.entries) {
    if (byName.has(entry.name)) errors.push(`$.entries: duplicate entry ${entry.name}`);
    byName.set(entry.name, entry);
  }
  const declared = (name: string): CatalogEntry | undefined => {
    const entry = byName.get(name);
    return entry === undefined || entry.status.kind === "unsupported" ? undefined : entry;
  };

  for (const entry of catalog.entries) {
    if (entry.kind !== "class") continue;
    const members = [...entry.fields, ...entry.methods];
    const names = new Set<string>();
    for (const member of members) {
      if (names.has(member.name))
        errors.push(`$.entries[${entry.name}]: duplicate member ${member.name}`);
      names.add(member.name);
    }
    for (const method of entry.methods) {
      const seen = new Map<string, number>();
      method.overloads.forEach((overload, index) => {
        const signature = overloadSignature(overload);
        const first = seen.get(signature);
        if (first !== undefined)
          errors.push(
            `$.entries[${entry.name}].${method.name}: overload ${index + 1} repeats the parameter signature of overload ${first + 1}: ${JSON.stringify(signature)}`,
          );
        else seen.set(signature, index);
      });
    }
    if (entry.extends !== null && declared(entry.extends) === undefined)
      errors.push(
        `$.entries[${entry.name}]: extends ${entry.extends}, which is not a published entry`,
      );
    for (const type of memberTypes(entry)) {
      for (const name of typeNames(type)) {
        if (TYPESCRIPT_NAMES.has(name) || declared(name) !== undefined) continue;
        errors.push(
          `$.entries[${entry.name}]: published type ${JSON.stringify(type)} names ${name}, which the catalog does not publish`,
        );
      }
    }
  }
  for (const entry of catalog.entries) {
    if (entry.kind !== "constant" || entry.status.kind === "unsupported") continue;
    // Back ends hand this value to games (PRD-540), so it must parse as the type it declares.
    if (constantValueError(entry) !== undefined)
      errors.push(`$.entries[${entry.name}]: ${constantValueError(entry)}`);
  }
  for (const entry of catalog.entries) {
    if (entry.kind !== "type" || entry.status.kind === "unsupported") continue;
    for (const name of typeNames(entry.type)) {
      if (TYPESCRIPT_NAMES.has(name) || declared(name) !== undefined) continue;
      errors.push(
        `$.entries[${entry.name}]: published type ${entry.type} names ${name}, which the catalog does not publish`,
      );
    }
  }
  return errors;
}

function constantValueError(entry: ICatalogConstantEntry): string | undefined {
  let value: unknown;
  try {
    value = typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
  } catch {
    value = undefined;
  }
  const matches = entry.type === "number" ? typeof value === "number" : typeof value === "string";
  return matches ? undefined : `value ${JSON.stringify(entry.value)} is not a ${entry.type}`;
}

/**
 * Validates a catalog against its schema and the rules JSON Schema cannot state.
 *
 * Fails closed: every disagreement is returned, and an empty array is the only pass.
 */
export function validateCatalog(catalog: unknown, schema: unknown): readonly string[] {
  const structural = schemaErrors(catalog, schema);
  return structural.length > 0 ? structural : semanticErrors(catalog as ICatalog);
}

export function formatErrors(errors: readonly string[]): string {
  return errors.map((message) => `  ${message}`).join("\n");
}

/** Keywords the hand-written validator ignores. A schema using one would pass unchecked. */
export function unsupportedSchemaKeywords(schema: unknown): readonly string[] {
  const unknown: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        unknown.push(key);
        continue;
      }
      // `properties` and `$defs` map names to schemas; their keys are not keywords.
      if (key === "properties" || key === "$defs") {
        for (const child of Object.values(record(value))) walk(child);
        continue;
      }
      walk(value);
    }
  };
  walk(schema);
  return [...new Set(unknown)].sort();
}

export function catalogPaths(root: string): { catalog: string; schema: string } {
  const directory = path.join(root, "packages", "three-native", "api");
  return {
    catalog: path.join(directory, "catalog.json"),
    schema: path.join(directory, "catalog.schema.json"),
  };
}

export function readCatalog(root: string): ICatalog {
  const { catalog, schema } = catalogPaths(root);
  return JSON.parse(readFileSync(catalog, "utf8")) as ICatalog;
}

export function readCatalogSchema(root: string): unknown {
  return JSON.parse(readFileSync(catalogPaths(root).schema, "utf8")) as unknown;
}

/** Loads and validates the committed catalog. Throws `TN_API_CATALOG_INVALID` when it disagrees. */
export function loadCatalog(root: string): ICatalog {
  const catalog = readCatalog(root);
  const errors = validateCatalog(catalog, readCatalogSchema(root));
  if (errors.length > 0)
    throw new Error(`TN_API_CATALOG_INVALID:\n${formatErrors(errors.slice(0, 20))}`);
  return catalog;
}

/** The published native surface: the entries `capabilities.json` must advertise for native. */
export function supportedNativeSymbols(
  catalog: ICatalog,
): readonly { readonly symbol: string; readonly kind: string; readonly source: string }[] {
  return catalog.entries
    .filter((entry) => entry.status.kind === "supported")
    .map((entry) => ({ symbol: entry.name, kind: entry.kind, source: entry.source }))
    .sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0));
}

const FNV_1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV_1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * The capability digest the version handshake compares: FNV-1a 64 over the UTF-8 bytes of
 * `TN_CAPABILITY_DIGEST_PREFIX` followed by the supported entry names sorted by code unit and joined
 * with `\n`, with no trailing newline.
 *
 * The prefix keeps a catalog with no supported entry from hashing to the FNV offset basis, and code
 * unit order rather than `localeCompare` keeps two machines that built the same catalog on the same
 * number. The engine recomputes it in C++ from `tn_engine_version()`'s names.
 */
export const TN_CAPABILITY_DIGEST_PREFIX = "tn/native/capability/v1:";

export function capabilityDigest(catalog: ICatalog): bigint {
  const names = catalog.entries
    .filter((entry) => entry.status.kind === "supported")
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const bytes = new TextEncoder().encode(`${TN_CAPABILITY_DIGEST_PREFIX}${names.join("\n")}`);
  let hash = FNV_1A_64_OFFSET;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * FNV_1A_64_PRIME) & UINT64_MASK;
  return hash;
}
