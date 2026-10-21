import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "runtime-native",
  "src",
);

export interface INativeSourceFile {
  path: string;
  text: string;
}

export interface INativeDefinitionOptions {
  /** Override the corpus. Used by the tests that prove this helper fails closed. */
  readFiles?: () => INativeSourceFile[];
  /** Restrict the walk; defaults to every C++ source and header under the native src tree. */
  root?: string;
}

function nativeSourceFiles(root: string): INativeSourceFile[] {
  const files: INativeSourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:cpp|cc|mm|h|hpp)$/u.test(entry.name)) {
        files.push({ path: full, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

/** A definition carries a body; a declaration ends in `;` and must not match. */
function definitionStart(text: string, symbol: string): number {
  const occurrences = text.matchAll(new RegExp(String.raw`\b${symbol}\b`, "gu"));
  for (const occurrence of occurrences) {
    const symbolStart = occurrence.index;
    const lineStart = text.lastIndexOf("\n", symbolStart - 1) + 1;
    const prefix = text.slice(lineStart, symbolStart).trim();
    const plausibleDeclarator =
      /^[A-Za-z_~][A-Za-z0-9_:\s<>,*&]*$/u.test(prefix) &&
      !/\b(?:if|for|while|switch|return|throw|new|delete)\b/u.test(prefix);
    if (!plausibleDeclarator) continue;
    const qualifiedCall = /^([A-Za-z_][A-Za-z0-9_]*::)+$/u.test(prefix);
    const finalQualifier = prefix.split("::").at(-2);
    if (qualifiedCall && finalQualifier !== symbol) continue;

    const parametersStart = text.indexOf("(", symbolStart + symbol.length);
    if (
      parametersStart < 0 ||
      text.slice(symbolStart + symbol.length, parametersStart).trim() !== ""
    ) {
      continue;
    }
    let depth = 0;
    let parametersEnd = -1;
    for (let index = parametersStart; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          parametersEnd = index;
          break;
        }
      }
    }
    if (parametersEnd < 0) continue;

    const bodyMarker = text.slice(parametersEnd + 1).search(/[;{]/u);
    if (bodyMarker < 0 || text[parametersEnd + 1 + bodyMarker] !== "{") continue;
    return lineStart;
  }
  return -1;
}

function bodyEnd(text: string, from: number): number {
  let depth = 0;
  for (let index = text.indexOf("{", from); index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error(`unbalanced braces after offset ${from}`);
}

/**
 * Locate a C++ definition by symbol rather than by file path, and return its whole body.
 *
 * PRD-229 Phase 5 exists because the assertions it replaces did neither. They hardcoded
 * `src/webgpu/bindings.cpp`, sliced with `indexOf`, and — when `indexOf` returned -1 because the
 * definition had moved — produced an empty string that satisfied every `not.toMatch` assertion
 * placed on it. A test that passes when its subject vanishes is worse than no test, and PRD-230
 * moves every one of these subjects.
 *
 * Fails closed in both directions: zero matches and more than one match are both errors.
 */
export function nativeDefinition(
  symbol: string,
  options: INativeDefinitionOptions = {},
): INativeSourceFile {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
    throw new Error(`native definition lookup needs a bare C++ identifier, got "${symbol}"`);
  }
  const files = options.readFiles?.() ?? nativeSourceFiles(options.root ?? NATIVE_SOURCE_ROOT);
  const hits = files
    .map((file) => ({ file, start: definitionStart(file.text, symbol) }))
    .filter((candidate) => candidate.start >= 0);

  if (hits.length === 0) {
    throw new Error(
      `no definition found for ${symbol} across ${files.length} native source files. If it was deliberately removed, delete the assertion in the same commit; if it was renamed, this test must follow the rename.`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `${symbol} is defined in more than one place: ${hits.map((hit) => hit.file.path).join(", ")}`,
    );
  }
  const [hit] = hits as [{ file: INativeSourceFile; start: number }];
  return {
    path: hit.file.path,
    text: hit.file.text.slice(hit.start, bodyEnd(hit.file.text, hit.start)),
  };
}

/** Follow binding-table references to the definition registered for one JS-visible method. */
export function nativeBindingDefinition(
  surface: string,
  name: string,
  options: INativeDefinitionOptions = {},
): INativeSourceFile {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(surface) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(
      `native binding lookup needs bare surface and method names, got ${surface}.${name}`,
    );
  }
  const files = options.readFiles?.() ?? nativeSourceFiles(options.root ?? NATIVE_SOURCE_ROOT);
  const snapshot: INativeDefinitionOptions = { readFiles: () => files };
  const pending = ["installWebGPUBindingTables"];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const symbol = pending.shift();
    if (symbol === undefined || visited.has(symbol)) continue;
    visited.add(symbol);
    const definition = nativeDefinition(symbol, snapshot);
    const row = definition.text.match(
      new RegExp(`\\{"${surface}",\\s*"${name}"[\\s\\S]*?&([A-Za-z_][A-Za-z0-9_]*)`, "u"),
    );
    if (row?.[1]) return nativeDefinition(row[1], snapshot);
    for (const reference of definition.text.matchAll(/&([A-Za-z_][A-Za-z0-9_]*)/gu)) {
      const referencedSymbol = reference[1];
      if (referencedSymbol === undefined) continue;
      try {
        nativeDefinition(referencedSymbol, snapshot);
        pending.push(referencedSymbol);
      } catch {
        // Binding rows also reference backend handles and data members; only definitions recurse.
      }
    }
  }
  throw new Error(`no native binding definition found for ${surface}.${name}`);
}
