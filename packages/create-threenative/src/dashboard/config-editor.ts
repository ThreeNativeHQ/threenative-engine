// The Dev Dashboard's `threenative.config.ts` writer (PRD-918). It edits the authored object
// literal in place through TypeScript's own parser, so comments, imports and every key it was not
// asked about stay byte for byte; the candidate text runs through `loadConfig` before anything is
// written, and the write is a rename, so a crash never leaves half a config on disk.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type * as Typescript from "typescript";
import { loadConfig } from "../config.js";
import {
  CONFIG_FIELDS,
  CRASH_REPORTS_PATH,
  configField,
  parseFieldValue,
} from "./config-fields.js";

const CONFIG_FILE = "threenative.config.ts";

type Ts = typeof Typescript;
let typescript: Ts | undefined;
async function ts(): Promise<Ts> {
  typescript ??= (await import("typescript")).default;
  return typescript;
}

export interface IConfigView {
  /** The value written in the file, per editable path; absent = not authored (default applies). */
  readonly authored: Record<string, unknown>;
  /** Paths whose authored value is an expression the editor will not rewrite. */
  readonly expressions: readonly string[];
  /** What `loadConfig` resolves, per editable path. */
  readonly resolved: Record<string, unknown>;
}

export class ConfigEditError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

const EDITABLE = [...CONFIG_FIELDS.map((field) => field.path), CRASH_REPORTS_PATH];

/** The config's root object literal: `export default {…}`, or `const config = {…}` it names. */
function rootObject(
  ts: Ts,
  file: Typescript.SourceFile,
): Typescript.ObjectLiteralExpression | undefined {
  const unwrap = (node: Typescript.Expression | undefined): Typescript.Expression | undefined => {
    let current = node;
    while (
      current &&
      (ts.isSatisfiesExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isParenthesizedExpression(current))
    )
      current = current.expression;
    // `defineConfig({…})`-shaped wrappers: the first argument is the object.
    if (current && ts.isCallExpression(current)) return unwrap(current.arguments[0]);
    return current;
  };
  let exported: Typescript.Expression | undefined;
  for (const statement of file.statements)
    if (ts.isExportAssignment(statement)) exported = unwrap(statement.expression);
  if (exported && ts.isIdentifier(exported)) {
    const name = exported.text;
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          exported = unwrap(declaration.initializer);
    }
  }
  return exported && ts.isObjectLiteralExpression(exported) ? exported : undefined;
}

function propertyName(ts: Ts, property: Typescript.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function findProperty(ts: Ts, object: Typescript.ObjectLiteralExpression, key: string) {
  return object.properties.find((property) => propertyName(ts, property) === key) as
    | Typescript.PropertyAssignment
    | undefined;
}

/** A literal's value, or `undefined` for anything that is not a plain literal. */
function literalValue(ts: Ts, node: Typescript.Expression): { value: unknown } | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { value: node.text };
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return { value: -Number(node.operand.text) };
  return undefined;
}

function read(object: unknown, dotted: string): unknown {
  let current = object;
  for (const key of dotted.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function parse(source: string) {
  const t = await ts();
  const file = t.createSourceFile(CONFIG_FILE, source, t.ScriptTarget.Latest, true);
  const object = rootObject(t, file);
  if (!object)
    throw new ConfigEditError(
      `${CONFIG_FILE} must default-export an object literal (or a const holding one) for the Dashboard to edit it.`,
    );
  return { t, file, object };
}

/** Authored literals, the expression paths, and the resolved config, for every editable path. */
export async function readConfigView(root: string): Promise<IConfigView> {
  const file = path.join(root, CONFIG_FILE);
  const source = await readFile(file, "utf8").catch(() => "export default {};\n");
  const { t, object } = await parse(source);
  const authored: Record<string, unknown> = {};
  const expressions: string[] = [];
  for (const dotted of EDITABLE) {
    let node: Typescript.ObjectLiteralExpression | undefined = object;
    const keys = dotted.split(".");
    for (const [index, key] of keys.entries()) {
      const property: Typescript.PropertyAssignment | undefined =
        node && findProperty(t, node, key);
      if (!property) break;
      if (index === keys.length - 1) {
        const literal = literalValue(t, property.initializer);
        if (literal) authored[dotted] = literal.value;
        else expressions.push(dotted);
      } else if (t.isObjectLiteralExpression(property.initializer)) node = property.initializer;
      else {
        expressions.push(dotted);
        break;
      }
    }
  }
  const config = await loadConfig(root);
  const resolved: Record<string, unknown> = {};
  for (const dotted of EDITABLE) {
    const value =
      dotted === CRASH_REPORTS_PATH
        ? config.telemetry?.crashReports !== false
        : read(config, dotted);
    if (value !== undefined) resolved[dotted] = value;
  }
  return { authored, expressions, resolved };
}

interface IEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const print = (value: unknown): string => JSON.stringify(value);

/** The line's indentation at `pos`, so inserted keys line up with their siblings. */
function indentAt(source: string, pos: number): string {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/u.exec(source.slice(lineStart))?.[0] ?? "";
}

/** `{ key: value }` nested for the remaining keys, e.g. `["crashReports"]` → `crashReports: false`. */
function nestedText(keys: readonly string[], value: unknown, indent: string, step: string): string {
  const [head, ...rest] = keys;
  if (rest.length === 0) return `${head}: ${print(value)}`;
  return `${head}: {\n${indent}${step}${nestedText(rest, value, indent + step, step)},\n${indent}}`;
}

function editFor(
  t: Ts,
  source: string,
  object: Typescript.ObjectLiteralExpression,
  keys: readonly string[],
  value: unknown,
): IEdit | undefined {
  const [key, ...rest] = keys as [string, ...string[]];
  const property = findProperty(t, object, key);
  if (property && rest.length > 0) {
    if (!t.isObjectLiteralExpression(property.initializer))
      throw new ConfigEditError(
        `${keys.join(".")} sits under an expression the Dashboard will not rewrite.`,
      );
    return editFor(t, source, property.initializer, rest, value);
  }
  if (property) {
    if (value === null) {
      // Remove the property, its trailing comma and the rest of its line (a trailing comment).
      let end = property.end;
      if (source[end] === ",") end += 1;
      const lineEnd = source.indexOf("\n", end);
      const tail = lineEnd === -1 ? "" : source.slice(end, lineEnd);
      if (lineEnd !== -1 && /^\s*(\/\/.*)?$/u.test(tail)) end = lineEnd;
      // A property on the file's first line has no newline before it.
      const start = Math.max(0, source.lastIndexOf("\n", property.getStart()));
      const lead = source.slice(start + 1, property.getStart());
      return /^\s*$/u.test(lead)
        ? { start, end, text: "" }
        : { start: property.getStart(), end, text: "" };
    }
    if (!literalValue(t, property.initializer))
      throw new ConfigEditError(`${keys.join(".")} is an expression; edit it in ${CONFIG_FILE}.`);
    return {
      start: property.initializer.getStart(),
      end: property.initializer.end,
      text: print(value),
    };
  }
  if (value === null) return undefined;
  // Insert a new property after the last one (or into an empty object).
  const last = object.properties[object.properties.length - 1];
  const step = "  ";
  if (!last) {
    const indent = indentAt(source, object.getStart());
    const open = object.getStart() + 1;
    return {
      start: open,
      end: object.end - 1,
      text: `\n${indent}${step}${nestedText(keys, value, indent + step, step)},\n${indent}`,
    };
  }
  const indent = indentAt(source, last.getStart());
  let at = last.end;
  const hasComma = source[at] === ",";
  if (hasComma) at += 1;
  // Keep a trailing `// comment` on the previous line with that line.
  const lineEnd = source.indexOf("\n", at);
  if (lineEnd !== -1 && /^[ \t]*\/\/.*$/u.test(source.slice(at, lineEnd))) at = lineEnd;
  // The missing comma goes right after the last property, never after its trailing comment.
  return {
    start: hasComma ? at : last.end,
    end: at,
    text: `${hasComma ? "" : `,${source.slice(last.end, at)}`}\n${indent}${nestedText(keys, value, indent, step)},`,
  };
}

/** Applies `changes` (path → value, `null` removes) to `source`; one parse per change. */
export async function applyConfigChanges(
  source: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<string> {
  const fields: Record<string, string> = {};
  const parsed: [string, unknown][] = [];
  for (const [dotted, raw] of Object.entries(changes)) {
    const field = configField(dotted);
    if (!field) {
      fields[dotted] = "not an editable config path";
      continue;
    }
    try {
      parsed.push([dotted, parseFieldValue(field, raw)]);
    } catch (error) {
      fields[dotted] = (error as Error).message;
    }
  }
  if (Object.keys(fields).length > 0) throw new ConfigEditError("Invalid config change", fields);
  let text = source;
  for (const [dotted, value] of parsed) {
    const { t, object } = await parse(text);
    const edit = editFor(t, text, object, dotted.split("."), value);
    if (edit) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}

/**
 * Validates and writes `changes` to the project's config. The candidate runs through `loadConfig`
 * first: an invalid value throws `ConfigEditError` naming the loader's message and writes nothing.
 * Returns the new view and whether the engine changed (the dev server must restart for that).
 */
export function patchConfig(
  root: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<{ view: IConfigView; engineChanged: boolean }> {
  // One save at a time per project: two quick edits would both read the old file, and the second
  // rename would drop the first edit.
  const key = path.resolve(root);
  const run = (saving.get(key) ?? Promise.resolve()).then(() => patchNow(root, changes));
  const tail = run.catch(() => undefined);
  saving.set(key, tail);
  void tail.then(() => {
    if (saving.get(key) === tail) saving.delete(key);
  });
  return run;
}

const saving = new Map<string, Promise<unknown>>();

async function patchNow(
  root: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<{ view: IConfigView; engineChanged: boolean }> {
  const file = path.join(root, CONFIG_FILE);
  // Only a missing file starts from the stub; any other read error must not overwrite the config.
  const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return 'import type { IThreeNativeConfig } from "@threenative/core";\n\nconst config: IThreeNativeConfig = {};\n\nexport default config;\n';
  });
  const before = await loadConfig(root, undefined, { source });
  const next = await applyConfigChanges(source, changes);
  let after: Awaited<ReturnType<typeof loadConfig>>;
  try {
    after = await loadConfig(root, undefined, { source: next });
  } catch (error) {
    const message = (error as Error).message;
    throw new ConfigEditError(
      message,
      Object.fromEntries(Object.keys(changes).map((k) => [k, message])),
    );
  }
  if (next !== source) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, next, "utf8");
    await rename(temp, file);
  }
  return { view: await readConfigView(root), engineChanged: before.engine !== after.engine };
}
