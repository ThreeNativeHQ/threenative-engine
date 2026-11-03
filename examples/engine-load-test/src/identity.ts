export interface IModuleGraphEntry {
  readonly bytes: Uint8Array;
  readonly url: string;
}

/** The benchmark's own source files; engine and renderer modules are artifact identity instead. */
export function isBenchmarkWorkloadModule(entry: IModuleGraphEntry): boolean {
  let pathname: string;
  try {
    pathname = new URL(entry.url).pathname;
  } catch {
    return false;
  }
  return (
    pathname === "/src/game.ts" ||
    pathname === "/src/workload.ts" ||
    /^\/assets\/(?:game|workload)-[A-Za-z0-9_-]+\.ts$/u.test(pathname) ||
    pathname.endsWith("/examples/engine-load-test/src/game.ts") ||
    pathname.endsWith("/examples/engine-load-test/src/workload.ts")
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// These are complete Vite-served layouts, not directory names that may occur inside a dependency.
// A root candidate is valid only when a graph URL has one of these known checkout-relative suffixes.
const RECOGNIZED_VITE_LAYOUTS = [
  "examples/engine-load-test/src/",
  "packages/assets/src/",
  "packages/blender-bridge/src/",
  "packages/core/src/",
  "packages/create-threenative/src/",
  "packages/engine-mcp/src/",
  "packages/physics/src/",
  "packages/playtest/src/",
  "packages/raw-unreal/src/",
  "packages/runtime-native/src/",
  "packages/ueformat/src/",
  "packages/ui/src/",
  "scripts/engine-load-test/",
  "scripts/render-profile/",
] as const;

const RECOGNIZED_VITE_MODULE_PATHS = [
  "/src/",
  "/examples/engine-load-test/",
  "/packages/",
  "/node_modules/",
  "/@id/",
  "/@vite/",
] as const;

const INLINE_SOURCE_MAP_LINE = "//# sourceMappingURL=data:";
const INLINE_SOURCE_MAP_BLOCK = "/*# sourceMappingURL=data:";
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const FOR_HEADER_OPERAND_KEYWORDS = new Set([
  "await",
  "delete",
  "in",
  "instanceof",
  "new",
  "typeof",
  "void",
  "yield",
]);
const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const STATEMENT_BODY_KEYWORDS = new Set(["catch", "debugger", "do", "else", "finally", "try"]);
const DECLARATION_PREFIX_KEYWORDS = new Set(["abstract", "declare", "default", "export"]);

interface IIdentityContext {
  readonly checkoutPrefix?: string;
  readonly viteDependencyTokens?: ReadonlySet<string>;
}

interface IReferenceParts {
  readonly path: string;
  readonly suffix: string;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitReference(value: string): IReferenceParts {
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  const suffixStart = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
  return suffixStart === -1
    ? { path: value, suffix: "" }
    : { path: value.slice(0, suffixStart), suffix: value.slice(suffixStart) };
}

function fsPathFromVitePath(path: string): string | undefined {
  const prefix = "/@fs/";
  if (!path.startsWith(prefix)) return undefined;
  const payload = decodePath(path.slice(prefix.length)).replaceAll("\\", "/");
  if (payload.length === 0) return undefined;
  if (payload.startsWith("/")) return payload;
  if (payload.length >= 3 && payload[1] === ":" && payload[2] === "/") return payload;
  return `/${payload}`;
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split("/").includes(segment);
}

function checkoutPathCandidates(absolutePath: string): Set<string> {
  const normalized = absolutePath.replaceAll("\\", "/");
  const candidates = new Set<string>();
  for (const layout of RECOGNIZED_VITE_LAYOUTS) {
    const marker = `/${layout}`;
    let markerIndex = normalized.indexOf(marker);
    while (markerIndex !== -1) {
      if (markerIndex > 0) {
        const prefix = normalized.slice(0, markerIndex);
        // A package nested under node_modules is dependency identity, never checkout-root evidence.
        if (!hasPathSegment(prefix, "node_modules")) candidates.add(prefix);
      }
      markerIndex = normalized.indexOf(marker, markerIndex + 1);
    }
  }
  return candidates;
}

function localViteHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

interface ILocalReferenceParts {
  readonly hash: string;
  readonly path: string;
  readonly query: string;
}

function splitReferenceSuffix(suffix: string): Pick<ILocalReferenceParts, "hash" | "query"> {
  const hashIndex = suffix.indexOf("#");
  return hashIndex === -1
    ? { hash: "", query: suffix }
    : { hash: suffix.slice(hashIndex), query: suffix.slice(0, hashIndex) };
}

function recognizedViteModulePath(path: string): boolean {
  return (
    RECOGNIZED_VITE_MODULE_PATHS.some((prefix) => path.startsWith(prefix)) ||
    path === "/@vite/client" ||
    path === "/@react-refresh"
  );
}

function localReferenceParts(reference: string): ILocalReferenceParts | undefined {
  const raw = splitReference(reference);
  try {
    const url = new URL(reference);
    if (!localViteHost(url.hostname)) return undefined;
    return { hash: url.hash, path: url.pathname, query: url.search };
  } catch {
    const suffix = splitReferenceSuffix(raw.suffix);
    return { ...suffix, path: raw.path };
  }
}

function isViteOptimizedDependencyPath(path: string): boolean {
  return path.startsWith("/node_modules/.vite/deps/");
}

function observedViteDependencyToken(reference: string): string | undefined {
  const parts = localReferenceParts(reference);
  if (
    parts === undefined ||
    !isViteOptimizedDependencyPath(parts.path) ||
    !/^\?v=[0-9a-f]+$/iu.test(parts.query)
  ) {
    return undefined;
  }
  return `${parts.path}${parts.query}`;
}

function canonicalizeObservedViteDependencyReference(
  reference: string,
  context: IIdentityContext,
): string | undefined {
  const parts = localReferenceParts(reference);
  const token = observedViteDependencyToken(reference);
  if (parts === undefined || token === undefined || !context.viteDependencyTokens?.has(token)) {
    return undefined;
  }
  return `${parts.path}${parts.hash}`;
}

function createIdentityContext(entries: readonly IModuleGraphEntry[]): IIdentityContext {
  const checkoutPrefixes = new Set<string>();
  const viteDependencyTokens = new Set<string>();
  for (const entry of entries) {
    const viteDependencyToken = observedViteDependencyToken(entry.url);
    if (viteDependencyToken !== undefined) viteDependencyTokens.add(viteDependencyToken);
    const reference = splitReference(entry.url);
    let url: URL | undefined;
    try {
      url = new URL(entry.url);
    } catch {
      // Relative Vite paths and malformed external strings remain byte-sensitive.
    }
    const absolutePath =
      url === undefined || localViteHost(url.hostname)
        ? fsPathFromVitePath(url?.pathname ?? reference.path)
        : undefined;
    const candidates =
      absolutePath === undefined ? new Set<string>() : checkoutPathCandidates(absolutePath);
    for (const candidate of candidates) checkoutPrefixes.add(candidate);
  }
  return {
    checkoutPrefix: checkoutPrefixes.size === 1 ? [...checkoutPrefixes][0] : undefined,
    viteDependencyTokens,
  };
}

function canonicalCheckoutPath(
  path: string,
  checkoutPrefix: string | undefined,
): string | undefined {
  if (checkoutPrefix === undefined) return undefined;
  const absolutePath = fsPathFromVitePath(path);
  if (absolutePath === undefined) return undefined;
  const normalizedPrefix = checkoutPrefix.replaceAll("\\", "/");
  if (absolutePath !== normalizedPrefix && !absolutePath.startsWith(`${normalizedPrefix}/`)) {
    return undefined;
  }
  return absolutePath.slice(normalizedPrefix.length).replace(/^\/+/, "");
}

function canonicalizeModuleReference(reference: string, context: IIdentityContext): string {
  if (reference.startsWith("data:")) return reference;
  const viteReference = canonicalizeObservedViteDependencyReference(reference, context);
  if (viteReference !== undefined) return viteReference;
  const raw = splitReference(reference);
  const relativePath = canonicalCheckoutPath(raw.path, context.checkoutPrefix);
  if (relativePath !== undefined) return `${relativePath}${raw.suffix}`;

  try {
    const url = new URL(reference);
    if (!localViteHost(url.hostname)) return reference;
    const relativeUrlPath = canonicalCheckoutPath(url.pathname, context.checkoutPrefix);
    if (relativeUrlPath !== undefined) return `${relativeUrlPath}${url.search}${url.hash}`;
    if (recognizedViteModulePath(url.pathname)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Non-URL module specifiers are preserved unless they are recognized /@fs paths above.
  }
  return reference;
}

function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function isWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 11 ||
    code === 12 ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff ||
    isLineTerminator(code)
  );
}

function onlyWhitespaceAfter(source: string, start: number): boolean {
  for (let index = start; index < source.length; index += 1) {
    if (!isWhitespace(source.charCodeAt(index))) return false;
  }
  return true;
}

function commentEnd(source: string, index: number): number | undefined {
  if (source.startsWith("//", index)) {
    for (let end = index + 2; end < source.length; end += 1) {
      if (isLineTerminator(source.charCodeAt(end))) return end + 1;
    }
    return source.length;
  }
  if (!source.startsWith("/*", index)) return undefined;
  const end = source.indexOf("*/", index + 2);
  return end === -1 ? source.length : end + 2;
}

function terminalInlineSourceMapEnd(source: string, index: number): number | undefined {
  let end: number;
  if (source.startsWith(INLINE_SOURCE_MAP_LINE, index)) {
    end = index + INLINE_SOURCE_MAP_LINE.length;
    while (end < source.length && !isLineTerminator(source.charCodeAt(end))) end += 1;
    return onlyWhitespaceAfter(source, end) ? end : undefined;
  }
  if (!source.startsWith(INLINE_SOURCE_MAP_BLOCK, index)) return undefined;
  end = index + INLINE_SOURCE_MAP_BLOCK.length;
  while (end + 1 < source.length) {
    if (source.charCodeAt(end) === 42 && source.charCodeAt(end + 1) === 47) {
      const commentEndIndex = end + 2;
      return onlyWhitespaceAfter(source, commentEndIndex) ? commentEndIndex : undefined;
    }
    end += 1;
  }
  return undefined;
}

function quotedStringEnd(source: string, start: number, quote: string): number | undefined {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index;
    index += 1;
  }
  return undefined;
}

function skipQuotedLiteral(source: string, start: number): number {
  const end = quotedStringEnd(source, start + 1, source[start] ?? "");
  return end === undefined ? source.length : end + 1;
}

function decodeModuleSpecifier(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      decoded += value[index] ?? "";
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:invalid module specifier escape");
    }
    if (isLineTerminator(escaped.charCodeAt(0))) {
      index += escaped === "\r" && value[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (escaped === "x") {
      const first = hexDigitValue(value.charCodeAt(index + 2));
      const second = hexDigitValue(value.charCodeAt(index + 3));
      if (first === undefined || second === undefined) {
        throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:invalid module specifier escape");
      }
      decoded += String.fromCharCode(first * 16 + second);
      index += 3;
      continue;
    }
    if (escaped === "u") {
      if (value[index + 2] === "{") {
        const close = value.indexOf("}", index + 3);
        const digits = value.slice(index + 3, close === -1 ? value.length : close);
        if (
          close === -1 ||
          digits.length === 0 ||
          digits.length > 6 ||
          !/^[0-9a-f]+$/iu.test(digits)
        ) {
          throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:invalid module specifier escape");
        }
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) {
          throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:invalid module specifier escape");
        }
        decoded += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      let codePoint = 0;
      for (let offset = 0; offset < 4; offset += 1) {
        const digit = hexDigitValue(value.charCodeAt(index + 2 + offset));
        if (digit === undefined) {
          throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:invalid module specifier escape");
        }
        codePoint = codePoint * 16 + digit;
      }
      decoded += String.fromCharCode(codePoint);
      index += 5;
      continue;
    }
    const simpleEscape: Record<string, string> = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    decoded += simpleEscape[escaped] ?? escaped;
    index += 1;
  }
  return decoded;
}

function encodeModuleSpecifier(value: string, quote: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = value.charCodeAt(index);
    if (character === "\\") {
      encoded += "\\\\";
    } else if (character === quote) {
      encoded += `\\${quote}`;
    } else if (quote === "`" && character === "$" && value[index + 1] === "{") {
      encoded += "\\$";
    } else if (character === "\n") {
      encoded += "\\n";
    } else if (character === "\r") {
      encoded += "\\r";
    } else if (character === "\u2028") {
      encoded += "\\u2028";
    } else if (character === "\u2029") {
      encoded += "\\u2029";
    } else if (code < 0x20 || code === 0x7f) {
      encoded += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      encoded += character;
    }
  }
  return encoded;
}

function isIdentifierStart(code: number): boolean {
  return (
    code === 36 ||
    code === 95 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 128 && !isWhitespace(code))
  );
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

interface IIdentifierEscape {
  readonly codePoint: number;
  readonly end: number;
}

function hexDigitValue(code: number): number | undefined {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return undefined;
}

function readIdentifierEscape(source: string, start: number): IIdentifierEscape | undefined {
  if (source.charCodeAt(start) !== 92 || source.charCodeAt(start + 1) !== 117) return undefined;
  if (source.charCodeAt(start + 2) === 123) {
    let digits = 0;
    let index = start + 3;
    while (index < source.length) {
      const digit = hexDigitValue(source.charCodeAt(index));
      if (digit === undefined) break;
      digits += 1;
      index += 1;
    }
    if (digits === 0 || source.charCodeAt(index) !== 125) return undefined;
    const significantDigits = source.slice(start + 3, index).replace(/^0+/, "");
    if (significantDigits.length > 6) return undefined;
    const codePoint = Number.parseInt(significantDigits || "0", 16);
    if (codePoint > 0x10ffff) {
      return undefined;
    }
    return { codePoint, end: index + 1 };
  }

  let codePoint = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = hexDigitValue(source.charCodeAt(start + 2 + offset));
    if (digit === undefined) return undefined;
    codePoint = codePoint * 16 + digit;
  }
  return { codePoint, end: start + 6 };
}

function isIdentifierEscapeStart(source: string, start: number): boolean {
  const identifierEscape = readIdentifierEscape(source, start);
  return identifierEscape !== undefined && isIdentifierStart(identifierEscape.codePoint);
}

function skipIdentifier(source: string, start: number): number {
  let index = start;
  let first = true;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (first ? isIdentifierStart(code) : isIdentifierPart(code)) {
      index += 1;
      first = false;
      continue;
    }
    const identifierEscape = readIdentifierEscape(source, index);
    if (
      identifierEscape === undefined ||
      !(first
        ? isIdentifierStart(identifierEscape.codePoint)
        : isIdentifierPart(identifierEscape.codePoint))
    ) {
      break;
    }
    index = identifierEscape.end;
    first = false;
  }
  return index;
}

function skipNumber(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 46 || isIdentifierPart(code)) index += 1;
    else break;
  }
  return index;
}

function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (isLineTerminator(code)) return index;
    if (code === 91) inCharacterClass = true;
    if (code === 93) inCharacterClass = false;
    if (code === 47 && !inCharacterClass) return skipRegexFlags(source, index + 1);
    index += 1;
  }
  return source.length;
}

function skipRegexFlags(source: string, start: number): number {
  let index = start;
  while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index += 1;
  return index;
}

type TBraceContext =
  | "block"
  | "object"
  | "function-expression"
  | "function-statement"
  | "class-expression"
  | "class-statement";

type TClassBodyContext = "expression" | "statement";
type TControlParenKeyword = "catch" | "for" | "if" | "switch" | "while" | "with";
type TRestrictedProduction = "return" | "throw" | "yield";
type TForHeaderPhase = "init" | "test" | "update" | "iterable";

interface IClassBodyExpectation {
  context: TClassBodyContext;
  delimiterDepth: number;
}

interface IForHeaderState {
  canEndExpression: boolean;
  phase: TForHeaderPhase;
}

type TDelimiter =
  | {
      kind: "paren";
      context: "control";
      forHeader?: IForHeaderState;
      keyword: TControlParenKeyword;
    }
  | { kind: "paren"; context: "ordinary" }
  | { kind: "paren"; context: "function"; functionExpression: boolean }
  | { kind: "bracket" }
  | {
      kind: "brace";
      context: TBraceContext;
      classFieldInitializer?: boolean;
    };

interface IScannerState {
  canStartRegex: boolean;
  conditionalQuestions: number[];
  delimiters: TDelimiter[];
  expectBlock: boolean;
  expectClassBodies: IClassBodyExpectation[];
  expectControlParen: TControlParenKeyword | undefined;
  expectFunctionBody: "expression" | "statement" | undefined;
  expectFunctionExpression: boolean;
  expectFunctionParen: boolean;
  lineTerminatorSinceToken: boolean;
  pendingBreakContinue: boolean;
  pendingAsync: { statementStart: boolean } | undefined;
  propertyAccess: boolean;
  restrictedProduction: TRestrictedProduction | undefined;
  statementStart: boolean;
}

function createScannerState(): IScannerState {
  return {
    canStartRegex: true,
    conditionalQuestions: [],
    delimiters: [],
    expectBlock: false,
    expectClassBodies: [],
    expectControlParen: undefined,
    expectFunctionBody: undefined,
    expectFunctionExpression: false,
    expectFunctionParen: false,
    lineTerminatorSinceToken: false,
    pendingBreakContinue: false,
    pendingAsync: undefined,
    propertyAccess: false,
    restrictedProduction: undefined,
    statementStart: true,
  };
}

function clearScannerExpectations(state: IScannerState): void {
  state.expectBlock = false;
  state.expectClassBodies = state.expectClassBodies.filter(
    (expectation) => state.delimiters.length >= expectation.delimiterDepth,
  );
  state.expectControlParen = undefined;
  state.expectFunctionBody = undefined;
  state.expectFunctionExpression = false;
  state.expectFunctionParen = false;
}

function hasLineTerminator(source: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (isLineTerminator(source.charCodeAt(index))) return true;
  }
  return false;
}

function discardNestedConditionalQuestions(state: IScannerState): void {
  const depth = state.delimiters.length;
  while (state.conditionalQuestions.at(-1) !== undefined) {
    const questionDepth = state.conditionalQuestions.at(-1);
    if (questionDepth === undefined || questionDepth <= depth) return;
    state.conditionalQuestions.pop();
  }
}

function consumeConditionalQuestion(state: IScannerState): boolean {
  const depth = state.delimiters.length;
  for (let index = state.conditionalQuestions.length - 1; index >= 0; index -= 1) {
    if (state.conditionalQuestions[index] !== depth) continue;
    state.conditionalQuestions.splice(index, 1);
    return true;
  }
  return false;
}

function popDelimiter(state: IScannerState, kind: TDelimiter["kind"]): TDelimiter | undefined {
  const delimiter = state.delimiters[state.delimiters.length - 1];
  if (delimiter?.kind !== kind) return undefined;
  state.delimiters.pop();
  return delimiter;
}

function canStartDeclarationAtLineBreak(state: IScannerState): boolean {
  if (state.propertyAccess) return false;
  if (state.statementStart || state.canStartRegex) return state.statementStart;
  const enclosing = state.delimiters.at(-1);
  if (enclosing === undefined || enclosing.kind !== "brace") return enclosing === undefined;
  return (
    enclosing.context === "block" ||
    enclosing.context === "function-expression" ||
    enclosing.context === "function-statement"
  );
}

function forHeaderState(state: IScannerState): IForHeaderState | undefined {
  const delimiter = state.delimiters.at(-1);
  if (
    delimiter?.kind !== "paren" ||
    delimiter.context !== "control" ||
    delimiter.keyword !== "for"
  ) {
    return undefined;
  }
  return delimiter.forHeader;
}

function classBodyDelimiter(
  state: IScannerState,
): Extract<TDelimiter, { kind: "brace" }> | undefined {
  const delimiter = state.delimiters.at(-1);
  if (
    delimiter?.kind !== "brace" ||
    (delimiter.context !== "class-expression" && delimiter.context !== "class-statement")
  ) {
    return undefined;
  }
  return delimiter;
}

function startsForHeaderExpression(source: string, start: number): boolean {
  const next = skipTrivia(source, start);
  const code = source.charCodeAt(next);
  return next < source.length && ![41, 44, 58, 59, 61].includes(code);
}

function updateForHeaderIdentifier(
  state: IScannerState,
  word: string,
  propertyName: boolean,
  forHeaderSeparator: boolean,
): void {
  const header = forHeaderState(state);
  if (header === undefined || header.phase !== "init") return;
  if (forHeaderSeparator) {
    header.phase = "iterable";
    header.canEndExpression = false;
    return;
  }
  header.canEndExpression =
    propertyName ||
    (!["const", "let", "var"].includes(word) && !FOR_HEADER_OPERAND_KEYWORDS.has(word));
}

function updateForHeaderPunctuation(state: IScannerState, code: number): void {
  const header = forHeaderState(state);
  if (header === undefined) return;
  if (code === 59) {
    header.phase =
      header.phase === "init" ? "test" : header.phase === "test" ? "update" : header.phase;
    header.canEndExpression = false;
    return;
  }
  if (header.phase === "init") header.canEndExpression = false;
}

function updateForHeaderExpressionEnd(state: IScannerState, canEndExpression: boolean): void {
  const header = forHeaderState(state);
  if (header !== undefined && header.phase !== "iterable") {
    header.canEndExpression = canEndExpression;
  }
}

function controlParenKeyword(word: string): TControlParenKeyword | undefined {
  return CONTROL_PAREN_KEYWORDS.has(word) ? (word as TControlParenKeyword) : undefined;
}

function applyRestrictedProductionBoundary(
  state: IScannerState,
  lineTerminatorBeforeToken: boolean,
): void {
  if (state.restrictedProduction === undefined) return;
  if (lineTerminatorBeforeToken) {
    state.canStartRegex = true;
    state.propertyAccess = false;
    state.statementStart = true;
    clearScannerExpectations(state);
  }
  state.restrictedProduction = undefined;
}

function scanIdentifierToken(
  source: string,
  start: number,
  state: IScannerState,
  lineTerminatorBeforeToken: boolean,
): number {
  const end = skipIdentifier(source, start);
  const word = source.slice(start, end);
  const propertyNameBeforeToken = isPropertyNameToken(source, end, state);
  const tokenStatementStart = state.statementStart;
  const lineTerminatorStatementStart =
    lineTerminatorBeforeToken && canStartDeclarationAtLineBreak(state);
  const keywordStatementStart =
    !propertyNameBeforeToken && (tokenStatementStart || lineTerminatorStatementStart);
  const pendingAsync = state.pendingAsync;
  state.pendingAsync = undefined;
  const declarationStatement =
    !propertyNameBeforeToken && (word === "function" || word === "class") && keywordStatementStart;
  const asyncFunctionDeclaration =
    word === "function" &&
    pendingAsync !== undefined &&
    (pendingAsync.statementStart || (lineTerminatorBeforeToken && keywordStatementStart));
  const controlParen = keywordStatementStart ? controlParenKeyword(word) : undefined;
  const forAwait =
    state.expectControlParen === "for" && word === "await" && !propertyNameBeforeToken;
  const header = forHeaderState(state);
  const forHeaderSeparator =
    header !== undefined &&
    header.phase === "init" &&
    header.canEndExpression &&
    (word === "in" || word === "of") &&
    startsForHeaderExpression(source, end);
  const statementBody =
    !propertyNameBeforeToken && keywordStatementStart && STATEMENT_BODY_KEYWORDS.has(word);
  const declarationPrefix =
    !propertyNameBeforeToken && tokenStatementStart && DECLARATION_PREFIX_KEYWORDS.has(word);
  const regexPrefixKeyword =
    !propertyNameBeforeToken &&
    ((REGEX_PREFIX_KEYWORDS.has(word) && word !== "of") || (word === "of" && forHeaderSeparator));
  const restrictedProduction =
    !propertyNameBeforeToken &&
    ((keywordStatementStart && (word === "return" || word === "throw")) || word === "yield")
      ? (word as TRestrictedProduction)
      : undefined;
  const breakContinueStatement =
    !propertyNameBeforeToken && keywordStatementStart && (word === "break" || word === "continue");
  const functionExpression =
    word === "function" && !propertyNameBeforeToken
      ? pendingAsync === undefined
        ? !declarationStatement
        : !asyncFunctionDeclaration
      : false;
  const keepFunctionExpression = state.expectFunctionExpression;
  const keepFunctionParen = state.expectFunctionParen;
  const keepClassBodies = state.expectClassBodies;

  state.canStartRegex = regexPrefixKeyword || statementBody || breakContinueStatement;
  state.statementStart = statementBody || declarationPrefix;
  state.expectBlock = statementBody;
  state.expectClassBodies = keepClassBodies;
  state.expectFunctionExpression = keepFunctionExpression;
  state.expectControlParen = forAwait ? "for" : controlParen;
  state.expectFunctionParen = keepFunctionParen;

  if (word === "function" && !propertyNameBeforeToken) {
    state.canStartRegex = false;
    state.statementStart = false;
    state.expectBlock = false;
    state.expectFunctionExpression = functionExpression;
    state.expectFunctionParen = true;
  } else if (word === "class" && !propertyNameBeforeToken) {
    state.canStartRegex = false;
    state.statementStart = false;
    state.expectBlock = false;
    state.expectClassBodies.push({
      context: declarationStatement ? "statement" : "expression",
      delimiterDepth: state.delimiters.length,
    });
  }
  state.pendingBreakContinue = breakContinueStatement;
  if (word === "async" && !propertyNameBeforeToken) {
    state.pendingAsync = { statementStart: keywordStatementStart };
  }
  state.restrictedProduction = restrictedProduction;
  state.propertyAccess = false;
  updateForHeaderIdentifier(state, word, propertyNameBeforeToken, forHeaderSeparator);
  return end;
}

function scanArrowToken(source: string, start: number, state: IScannerState): number {
  state.canStartRegex = true;
  state.statementStart = false;
  state.expectBlock = true;
  state.expectControlParen = undefined;
  state.expectFunctionBody = "expression";
  state.expectFunctionExpression = false;
  state.expectFunctionParen = false;
  state.propertyAccess = false;
  updateForHeaderPunctuation(state, 61);
  return start + 2;
}

function scanSpreadToken(source: string, start: number, state: IScannerState): number {
  state.canStartRegex = true;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  updateForHeaderPunctuation(state, 46);
  return start + 3;
}

function scanOpenParenToken(source: string, start: number, state: IScannerState): number {
  updateForHeaderExpressionEnd(state, false);
  if (state.expectControlParen !== undefined) {
    state.delimiters.push({
      kind: "paren",
      context: "control",
      ...(state.expectControlParen === "for"
        ? { forHeader: { canEndExpression: false, phase: "init" as const } }
        : {}),
      keyword: state.expectControlParen,
    });
  } else if (state.expectFunctionParen) {
    state.delimiters.push({
      kind: "paren",
      context: "function",
      functionExpression: state.expectFunctionExpression,
    });
  } else {
    state.delimiters.push({ kind: "paren", context: "ordinary" });
  }
  state.canStartRegex = true;
  state.statementStart = false;
  state.expectBlock = false;
  state.expectControlParen = undefined;
  state.expectFunctionExpression = false;
  state.expectFunctionParen = false;
  state.propertyAccess = false;
  return start + 1;
}

function scanOpenBracketToken(source: string, start: number, state: IScannerState): number {
  updateForHeaderExpressionEnd(state, false);
  state.delimiters.push({ kind: "bracket" });
  state.canStartRegex = true;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  return start + 1;
}

function braceContext(
  functionBody: IScannerState["expectFunctionBody"],
  classBody: TClassBodyContext | undefined,
  block: boolean,
): TBraceContext {
  if (functionBody === "expression") return "function-expression";
  if (functionBody === "statement") return "function-statement";
  if (classBody === "expression") return "class-expression";
  if (classBody === "statement") return "class-statement";
  return block ? "block" : "object";
}

function scanOpenBraceToken(
  source: string,
  start: number,
  state: IScannerState,
  lineTerminatorBeforeToken: boolean,
): number {
  updateForHeaderExpressionEnd(state, false);
  const functionBody = state.expectFunctionBody;
  const classBodyExpectation = [...state.expectClassBodies]
    .reverse()
    .find((expectation) => expectation.delimiterDepth === state.delimiters.length);
  const classBody =
    functionBody === undefined &&
    classBodyExpectation !== undefined &&
    classBodyExpectation.delimiterDepth === state.delimiters.length
      ? classBodyExpectation.context
      : undefined;
  const block =
    functionBody !== undefined ||
    classBody !== undefined ||
    state.expectBlock ||
    state.statementStart ||
    (lineTerminatorBeforeToken && canStartDeclarationAtLineBreak(state));
  const context = braceContext(functionBody, classBody, block);
  state.delimiters.push({
    kind: "brace",
    context,
    ...(classBody !== undefined ? { classFieldInitializer: false } : {}),
  });
  state.canStartRegex = true;
  state.statementStart = block;
  if (classBody !== undefined && classBodyExpectation !== undefined) {
    const expectationIndex = state.expectClassBodies.lastIndexOf(classBodyExpectation);
    if (expectationIndex !== -1) state.expectClassBodies.splice(expectationIndex, 1);
  }
  clearScannerExpectations(state);
  state.propertyAccess = false;
  return start + 1;
}

function scanCloseParenToken(source: string, start: number, state: IScannerState): number {
  const delimiter = popDelimiter(state, "paren");
  discardNestedConditionalQuestions(state);
  const control = delimiter?.kind === "paren" && delimiter.context === "control";
  const functionBody =
    delimiter?.kind === "paren" && delimiter.context === "function"
      ? delimiter.functionExpression
        ? "expression"
        : "statement"
      : undefined;
  state.canStartRegex = control;
  state.statementStart = control;
  state.expectBlock = delimiter !== undefined;
  state.expectControlParen = undefined;
  state.expectFunctionBody = functionBody;
  state.expectFunctionExpression = false;
  state.expectFunctionParen = false;
  state.propertyAccess = false;
  updateForHeaderExpressionEnd(state, true);
  return start + 1;
}

function scanCloseBracketToken(source: string, start: number, state: IScannerState): number {
  popDelimiter(state, "bracket");
  discardNestedConditionalQuestions(state);
  state.canStartRegex = false;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  updateForHeaderExpressionEnd(state, true);
  return start + 1;
}

function scanCloseBraceToken(source: string, start: number, state: IScannerState): number {
  const delimiter = popDelimiter(state, "brace");
  const block =
    delimiter?.kind === "brace" &&
    (delimiter.context === "block" ||
      delimiter.context === "function-statement" ||
      delimiter.context === "class-statement");
  const expression =
    delimiter?.kind === "brace" &&
    (delimiter.context === "function-expression" || delimiter.context === "class-expression");
  discardNestedConditionalQuestions(state);
  state.canStartRegex = expression ? false : block;
  state.statementStart = expression ? false : block;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  updateForHeaderExpressionEnd(state, true);
  return start + 1;
}

function scanRepeatedSignToken(source: string, start: number, state: IScannerState): number {
  const prefix = state.canStartRegex;
  state.canStartRegex = prefix;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  updateForHeaderExpressionEnd(state, !prefix);
  return start + 2;
}

function scanDotToken(source: string, start: number, state: IScannerState): number {
  state.canStartRegex = false;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = true;
  updateForHeaderExpressionEnd(state, false);
  return start + 1;
}

function scanNullishToken(source: string, start: number, state: IScannerState): number {
  state.canStartRegex = true;
  state.statementStart = false;
  clearScannerExpectations(state);
  state.propertyAccess = false;
  updateForHeaderPunctuation(state, 63);
  return source.charCodeAt(start + 2) === 61 ? start + 3 : start + 2;
}

function insideObjectLiteral(state: IScannerState): boolean {
  for (let index = state.delimiters.length - 1; index >= 0; index -= 1) {
    const delimiter = state.delimiters[index];
    if (delimiter?.kind === "brace") return delimiter.context === "object";
  }
  return false;
}

function isPropertyNameToken(source: string, end: number, state: IScannerState): boolean {
  if (state.propertyAccess) return true;
  const nextCode = source.charCodeAt(skipTrivia(source, end));
  if (insideObjectLiteral(state) && nextCode === 58) return true;
  const delimiter = classBodyDelimiter(state);
  return (
    delimiter !== undefined &&
    !delimiter.classFieldInitializer &&
    (nextCode === 40 || nextCode === 58 || nextCode === 59 || nextCode === 61)
  );
}

function scanOtherPunctuationToken(source: string, start: number, state: IScannerState): number {
  const code = source.charCodeAt(start);
  const nextCode = source.charCodeAt(start + 1);
  const classBodyState = classBodyDelimiter(state);
  const keepFunctionParen = state.expectFunctionParen && code === 42;
  const keepFunctionExpression = keepFunctionParen && state.expectFunctionExpression;
  const conditionalQuestion = code === 63 && nextCode !== 63 && nextCode !== 46;
  const conditionalColon = code === 58 && consumeConditionalQuestion(state);
  const classBodyExpectation = [...state.expectClassBodies]
    .reverse()
    .find((expectation) => expectation.delimiterDepth === state.delimiters.length);
  const clearClassBody =
    classBodyExpectation !== undefined && (code === 44 || code === 58 || code === 59);
  updateForHeaderPunctuation(state, code);
  state.canStartRegex = true;
  state.statementStart =
    code === 59 || (code === 58 && !conditionalColon && !insideObjectLiteral(state));
  if (conditionalQuestion) state.conditionalQuestions.push(state.delimiters.length);
  state.expectBlock = false;
  if (classBodyState !== undefined) {
    if (code === 61) classBodyState.classFieldInitializer = true;
    if (code === 59) classBodyState.classFieldInitializer = false;
  }
  if (clearClassBody) {
    const expectationIndex = state.expectClassBodies.lastIndexOf(classBodyExpectation);
    if (expectationIndex !== -1) state.expectClassBodies.splice(expectationIndex, 1);
  }
  state.expectControlParen = undefined;
  state.expectFunctionBody = undefined;
  state.expectFunctionExpression = keepFunctionExpression;
  state.expectFunctionParen = keepFunctionParen;
  state.propertyAccess = code === 35;
  return start + 1;
}

function scanPunctuationToken(
  source: string,
  start: number,
  state: IScannerState,
  lineTerminatorBeforeToken: boolean,
): number {
  const code = source.charCodeAt(start);
  const nextCode = source.charCodeAt(start + 1);
  switch (code) {
    case 40:
      return scanOpenParenToken(source, start, state);
    case 41:
      return scanCloseParenToken(source, start, state);
    case 91:
      return scanOpenBracketToken(source, start, state);
    case 93:
      return scanCloseBracketToken(source, start, state);
    case 123:
      return scanOpenBraceToken(source, start, state, lineTerminatorBeforeToken);
    case 125:
      return scanCloseBraceToken(source, start, state);
    case 43:
    case 45:
      return nextCode === code
        ? scanRepeatedSignToken(source, start, state)
        : scanOtherPunctuationToken(source, start, state);
    case 46:
      return nextCode === 46 && source.charCodeAt(start + 2) === 46
        ? scanSpreadToken(source, start, state)
        : scanDotToken(source, start, state);
    case 63:
      return nextCode === 63
        ? scanNullishToken(source, start, state)
        : scanOtherPunctuationToken(source, start, state);
    case 61:
      return nextCode === 62
        ? scanArrowToken(source, start, state)
        : scanOtherPunctuationToken(source, start, state);
    default:
      return scanOtherPunctuationToken(source, start, state);
  }
}

function skipTemplateExpression(source: string, start: number): number {
  const state = createScannerState();
  let index = start;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 125 && state.delimiters.length === 0) return index + 1;
    if (isWhitespace(code)) {
      if (isLineTerminator(code)) state.lineTerminatorSinceToken = true;
      index += 1;
      continue;
    }
    index = scanJavaScriptToken(source, index, state);
  }
  return source.length;
}

function skipTemplateLiteral(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
    } else if (code === 96) {
      return index + 1;
    } else if (code === 36 && source.charCodeAt(index + 1) === 123) {
      index = skipTemplateExpression(source, index + 2);
    } else {
      index += 1;
    }
  }
  return index;
}

function scanJavaScriptToken(source: string, start: number, state: IScannerState): number {
  const code = source.charCodeAt(start);
  if (code === 47 && (source.charCodeAt(start + 1) === 47 || source.charCodeAt(start + 1) === 42)) {
    const end = commentEnd(source, start) ?? start + 1;
    state.lineTerminatorSinceToken ||= hasLineTerminator(source, start, end);
    return end;
  }
  const lineTerminatorBeforeToken = state.lineTerminatorSinceToken;
  state.lineTerminatorSinceToken = false;
  applyRestrictedProductionBoundary(state, lineTerminatorBeforeToken);
  if (state.pendingBreakContinue) {
    const label =
      !lineTerminatorBeforeToken &&
      (isIdentifierStart(code) || isIdentifierEscapeStart(source, start));
    state.pendingBreakContinue = false;
    state.canStartRegex = true;
    state.statementStart = true;
    state.pendingAsync = undefined;
    clearScannerExpectations(state);
    state.propertyAccess = false;
    if (label) return skipIdentifier(source, start);
  }
  if (code === 34 || code === 39) {
    state.pendingAsync = undefined;
    state.canStartRegex = false;
    state.statementStart = false;
    clearScannerExpectations(state);
    state.propertyAccess = false;
    updateForHeaderExpressionEnd(state, true);
    return skipQuotedLiteral(source, start);
  }
  if (code === 96) {
    state.pendingAsync = undefined;
    state.canStartRegex = false;
    state.statementStart = false;
    clearScannerExpectations(state);
    state.propertyAccess = false;
    updateForHeaderExpressionEnd(state, true);
    return skipTemplateLiteral(source, start);
  }
  if (code === 47) {
    const nextCode = source.charCodeAt(start + 1);
    state.pendingAsync = undefined;
    if (state.canStartRegex) {
      state.canStartRegex = false;
      state.statementStart = false;
      clearScannerExpectations(state);
      state.propertyAccess = false;
      updateForHeaderExpressionEnd(state, true);
      return skipRegexLiteral(source, start);
    }
    state.canStartRegex = true;
    state.statementStart = false;
    clearScannerExpectations(state);
    state.propertyAccess = false;
    updateForHeaderExpressionEnd(state, false);
    return start + (nextCode === 61 ? 2 : 1);
  }
  if (isIdentifierStart(code) || isIdentifierEscapeStart(source, start))
    return scanIdentifierToken(source, start, state, lineTerminatorBeforeToken);
  if (code >= 48 && code <= 57) {
    state.pendingAsync = undefined;
    state.canStartRegex = false;
    state.statementStart = false;
    clearScannerExpectations(state);
    state.propertyAccess = false;
    updateForHeaderExpressionEnd(state, true);
    return skipNumber(source, start);
  }
  return scanPunctuationToken(source, start, state, lineTerminatorBeforeToken);
}

function stripInlineSourceMapMetadata(source: string): string {
  const state = createScannerState();
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (isWhitespace(code)) {
      if (isLineTerminator(code)) state.lineTerminatorSinceToken = true;
      index += 1;
      continue;
    }
    if (
      code === 47 &&
      (source.charCodeAt(index + 1) === 47 || source.charCodeAt(index + 1) === 42)
    ) {
      const terminalEnd = terminalInlineSourceMapEnd(source, index);
      if (terminalEnd !== undefined) return source.slice(0, index) + source.slice(terminalEnd);
      const commentEndIndex = commentEnd(source, index) ?? index + 1;
      state.lineTerminatorSinceToken ||= hasLineTerminator(source, index, commentEndIndex);
      index = commentEndIndex;
      continue;
    }
    index = scanJavaScriptToken(source, index, state);
  }
  return source;
}

type TModuleSourceToken =
  | { kind: "identifier"; propertyAccess: boolean; value: string }
  | { kind: "literal" }
  | { kind: "spread" }
  | { kind: "punctuation"; code: number };

type TModuleStatement = "import" | "export";
type TExportDeclarationForm = "unknown" | "from" | "default" | "declaration";

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (isWhitespace(source.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const end = commentEnd(source, index);
    if (end === undefined) return index;
    index = end;
  }
  return index;
}

function matchesImportMetaUrlCall(source: string, start: number): boolean {
  let index = skipTrivia(source, start);
  if (source.charCodeAt(index) !== 44) return false;
  index = skipTrivia(source, index + 1);
  for (const word of ["import", "meta", "url"]) {
    if (
      !source.startsWith(word, index) ||
      isIdentifierPart(source.charCodeAt(index + word.length))
    ) {
      return false;
    }
    index = skipTrivia(source, index + word.length);
    if (word === "url") continue;
    if (source.charCodeAt(index) !== 46) return false;
    index = skipTrivia(source, index + 1);
  }
  if (source.charCodeAt(index) === 44) index = skipTrivia(source, index + 1);
  return source.charCodeAt(index) === 41;
}

function isModuleReferenceLiteral(
  source: string,
  end: number,
  tokens: readonly TModuleSourceToken[],
  moduleStatement: TModuleStatement | undefined,
  exportDeclarationForm: TExportDeclarationForm,
): boolean {
  const previous = tokens.at(-1);
  const beforePrevious = tokens.at(-2);
  const propertyAccess = beforePrevious?.kind === "punctuation" && beforePrevious.code === 46;
  if (
    previous?.kind === "identifier" &&
    previous.value === "import" &&
    moduleStatement === "import" &&
    !propertyAccess &&
    !previous.propertyAccess
  ) {
    return true;
  }
  if (isDynamicImportCall(tokens)) return true;
  if (previous?.kind === "identifier" && previous.value === "from") {
    return (
      moduleStatement === "import" ||
      (moduleStatement === "export" &&
        exportDeclarationForm === "from" &&
        !propertyAccess &&
        !previous.propertyAccess)
    );
  }
  const urlConstructor = tokens.at(-2);
  const newKeyword = tokens.at(-3);
  return (
    previous?.kind === "punctuation" &&
    previous.code === 40 &&
    urlConstructor?.kind === "identifier" &&
    urlConstructor.value === "URL" &&
    !urlConstructor.propertyAccess &&
    newKeyword?.kind === "identifier" &&
    newKeyword.value === "new" &&
    !newKeyword.propertyAccess &&
    matchesImportMetaUrlCall(source, end + 1)
  );
}

function isDynamicImportCall(tokens: readonly TModuleSourceToken[]): boolean {
  const previous = tokens.at(-1);
  const dynamicImport = tokens.at(-2);
  const beforeDynamicImport = tokens.at(-3);
  return (
    previous?.kind === "punctuation" &&
    previous.code === 40 &&
    dynamicImport?.kind === "identifier" &&
    dynamicImport.value === "import" &&
    !dynamicImport.propertyAccess &&
    !(
      beforeDynamicImport?.kind === "punctuation" &&
      (beforeDynamicImport.code === 35 || beforeDynamicImport.code === 46)
    )
  );
}

function assertStaticDynamicImportArgument(
  source: string,
  end: number,
  tokens: readonly TModuleSourceToken[],
): void {
  if (!isDynamicImportCall(tokens)) return;
  const next = skipTrivia(source, end + 1);
  const nextCode = source.charCodeAt(next);
  if (nextCode !== 41 && nextCode !== 44) {
    throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:computed module specifier");
  }
}

interface IModuleCanonicalizationState {
  chunks: string[];
  exportDeclarationForm: TExportDeclarationForm;
  moduleStatement: TModuleStatement | undefined;
  moduleReferences: Set<string>;
  namedClauseDelimiterDepth: number | undefined;
  outputStart: number;
  scanner: IScannerState;
  tokens: TModuleSourceToken[];
}

function clearModuleStatement(state: IModuleCanonicalizationState): void {
  state.exportDeclarationForm = "unknown";
  state.moduleStatement = undefined;
}

function scannerAtStatementStart(state: IScannerState): boolean {
  return (
    state.statementStart ||
    (state.lineTerminatorSinceToken && canStartDeclarationAtLineBreak(state))
  );
}

function scannerAtModuleItemStart(state: IScannerState): boolean {
  return state.delimiters.length === 0 && scannerAtStatementStart(state);
}

function startsIdentifier(source: string, start: number, value: string): boolean {
  return (
    source.startsWith(value, start) && !isIdentifierPart(source.charCodeAt(start + value.length))
  );
}

function endModuleStatementAtLineBreak(
  source: string,
  start: number,
  state: IModuleCanonicalizationState,
): void {
  if (!state.scanner.lineTerminatorSinceToken || !scannerAtStatementStart(state.scanner)) return;
  if (
    state.namedClauseDelimiterDepth !== undefined &&
    state.scanner.delimiters.length >= state.namedClauseDelimiterDepth
  ) {
    return;
  }
  const previous = state.tokens.at(-1);
  const beforePrevious = state.tokens.at(-2);
  const previousIsContinuation =
    previous?.kind === "identifier" &&
    ((state.moduleStatement === "import" &&
      (previous.value === "import" || previous.value === "from")) ||
      (state.moduleStatement === "export" &&
        state.exportDeclarationForm === "from" &&
        previous.value === "from"));
  const previousIsNamespaceBinding =
    previous?.kind === "identifier" &&
    previous.value === "as" &&
    !previous.propertyAccess &&
    beforePrevious?.kind === "punctuation" &&
    beforePrevious.code === 42 &&
    (state.moduleStatement === "import" ||
      (state.moduleStatement === "export" && state.exportDeclarationForm === "from"));
  const previousIsNamedClauseOpen =
    previous?.kind === "punctuation" &&
    previous.code === 123 &&
    (state.moduleStatement === "import" ||
      (state.moduleStatement === "export" && state.exportDeclarationForm === "from"));
  const currentIsExportFrom =
    state.moduleStatement === "export" &&
    state.exportDeclarationForm === "from" &&
    startsIdentifier(source, start, "from");
  const currentIsImportFrom =
    state.moduleStatement === "import" && startsIdentifier(source, start, "from");
  const currentIsImportContinuation =
    state.moduleStatement === "import" && source.charCodeAt(start) === 44;
  const currentIsExportClause =
    state.moduleStatement === "export" &&
    state.exportDeclarationForm === "unknown" &&
    (source.charCodeAt(start) === 42 || source.charCodeAt(start) === 123);
  if (
    !previousIsContinuation &&
    !previousIsNamespaceBinding &&
    !previousIsNamedClauseOpen &&
    !currentIsExportFrom &&
    !currentIsImportFrom &&
    !currentIsImportContinuation &&
    !currentIsExportClause
  ) {
    clearModuleStatement(state);
  }
}

function scanModuleSourceString(
  source: string,
  start: number,
  context: IIdentityContext,
  state: IModuleCanonicalizationState,
): number {
  const end = quotedStringEnd(source, start + 1, source[start] ?? "");
  if (end === undefined) return source.length;
  const moduleReference = isModuleReferenceLiteral(
    source,
    end,
    state.tokens,
    state.moduleStatement,
    state.exportDeclarationForm,
  );
  if (moduleReference) {
    const rawValue = source.slice(start + 1, end);
    assertStaticDynamicImportArgument(source, end, state.tokens);
    const value = decodeModuleSpecifier(rawValue);
    state.moduleReferences.add(value);
    const canonical = canonicalizeModuleReference(value, context);
    if (canonical !== rawValue) {
      state.chunks.push(
        source.slice(state.outputStart, start + 1),
        encodeModuleSpecifier(canonical, source[start] ?? '"'),
      );
      state.outputStart = end;
    }
  }
  state.tokens.push({ kind: "literal" });
  if (
    moduleReference &&
    (state.moduleStatement === "import" ||
      (state.moduleStatement === "export" && state.exportDeclarationForm === "from"))
  ) {
    clearModuleStatement(state);
  }
  return scanJavaScriptToken(source, start, state.scanner);
}

function scanModuleSourceIdentifier(
  source: string,
  start: number,
  state: IModuleCanonicalizationState,
): number {
  const end = skipIdentifier(source, start);
  const word = source.slice(start, end);
  const propertyName = isPropertyNameToken(source, end, state.scanner);
  const previous = state.tokens.at(-1);
  const beforePrevious = state.tokens.at(-2);
  const beforeGenerator = state.tokens.at(-3);
  const enclosing = state.scanner.delimiters.at(-1);
  const objectMemberSeparator = (token: TModuleSourceToken | undefined): boolean =>
    token?.kind === "punctuation" && (token.code === 44 || token.code === 123);
  const objectGeneratorMethodName =
    previous?.kind === "punctuation" &&
    previous.code === 42 &&
    (objectMemberSeparator(beforePrevious) ||
      (beforePrevious?.kind === "identifier" &&
        beforePrevious.value === "async" &&
        objectMemberSeparator(beforeGenerator)));
  const objectMethodName =
    word === "import" &&
    enclosing?.kind === "brace" &&
    enclosing.context === "object" &&
    source.charCodeAt(skipTrivia(source, end)) === 40 &&
    (objectMemberSeparator(previous) ||
      objectGeneratorMethodName ||
      (previous?.kind === "identifier" &&
        (previous.value === "async" || previous.value === "get" || previous.value === "set")));
  if (!propertyName && !objectMethodName && word === "import") {
    const callStart = skipTrivia(source, end);
    if (source.charCodeAt(callStart) === 40) {
      const argumentStart = skipTrivia(source, callStart + 1);
      const argumentCode = source.charCodeAt(argumentStart);
      if (argumentCode !== 34 && argumentCode !== 39 && argumentCode !== 96) {
        throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:computed module specifier");
      }
    }
  }
  if (
    !propertyName &&
    (word === "import" || word === "export") &&
    scannerAtModuleItemStart(state.scanner)
  ) {
    state.moduleStatement = word;
    state.exportDeclarationForm = "unknown";
  } else if (propertyName && (word === "from" || word === "import")) {
    clearModuleStatement(state);
  } else if (state.moduleStatement === "export" && state.exportDeclarationForm === "unknown") {
    if (word === "default") state.exportDeclarationForm = "default";
    if (["async", "class", "const", "declare", "function", "let", "var"].includes(word)) {
      state.exportDeclarationForm = "declaration";
    }
  }
  state.tokens.push({
    kind: "identifier",
    propertyAccess: propertyName,
    value: word,
  });
  return scanJavaScriptToken(source, start, state.scanner);
}

function scanModuleSourcePunctuation(
  source: string,
  start: number,
  state: IModuleCanonicalizationState,
): number {
  const code = source.charCodeAt(start);
  const nextCode = source.charCodeAt(start + 1);
  if (
    code === 123 &&
    (state.moduleStatement === "import" ||
      (state.moduleStatement === "export" &&
        (state.exportDeclarationForm === "from" || state.exportDeclarationForm === "unknown")))
  ) {
    if (state.moduleStatement === "export" && state.exportDeclarationForm === "unknown") {
      state.exportDeclarationForm = "from";
    }
    state.namedClauseDelimiterDepth = state.scanner.delimiters.length + 1;
  } else if (code === 125 && state.namedClauseDelimiterDepth === state.scanner.delimiters.length) {
    state.namedClauseDelimiterDepth = undefined;
  } else if (code === 59) {
    clearModuleStatement(state);
  } else if (
    state.moduleStatement === "export" &&
    state.exportDeclarationForm === "unknown" &&
    code === 42
  ) {
    state.exportDeclarationForm = "from";
  }
  state.tokens.push(
    code === 46 && nextCode === 46 && source.charCodeAt(start + 2) === 46
      ? { kind: "spread" }
      : { kind: "punctuation", code },
  );
  return scanJavaScriptToken(source, start, state.scanner);
}

function scanTemplateExpressionForModuleReferences(
  source: string,
  start: number,
  context: IIdentityContext,
  outerState: IModuleCanonicalizationState,
): number {
  const expressionState: IModuleCanonicalizationState = {
    chunks: outerState.chunks,
    exportDeclarationForm: "unknown",
    moduleStatement: undefined,
    moduleReferences: outerState.moduleReferences,
    namedClauseDelimiterDepth: undefined,
    outputStart: outerState.outputStart,
    scanner: createScannerState(),
    tokens: [],
  };
  expressionState.scanner.statementStart = false;
  let index = start;
  while (index < source.length) {
    if (source.charCodeAt(index) === 125 && expressionState.scanner.delimiters.length === 0) {
      outerState.outputStart = expressionState.outputStart;
      return index + 1;
    }
    const nextIndex = scanModuleSourceToken(source, index, context, expressionState);
    if (nextIndex <= index) break;
    index = nextIndex;
  }
  outerState.outputStart = expressionState.outputStart;
  return source.length;
}

function scanModuleSourceTemplate(
  source: string,
  start: number,
  context: IIdentityContext,
  state: IModuleCanonicalizationState,
): number {
  let index = start + 1;
  let hasExpression = false;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === 96) {
      const moduleReference = isModuleReferenceLiteral(
        source,
        index,
        state.tokens,
        state.moduleStatement,
        state.exportDeclarationForm,
      );
      if (moduleReference) {
        if (hasExpression) {
          throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:computed module specifier");
        }
        assertStaticDynamicImportArgument(source, index, state.tokens);
        const rawValue = source.slice(start + 1, index);
        const value = decodeModuleSpecifier(rawValue);
        state.moduleReferences.add(value);
        const canonical = canonicalizeModuleReference(value, context);
        if (canonical !== rawValue) {
          state.chunks.push(
            source.slice(state.outputStart, start + 1),
            encodeModuleSpecifier(canonical, "`"),
          );
          state.outputStart = index;
        }
      }
      state.tokens.push({ kind: "literal" });
      return scanJavaScriptToken(source, start, state.scanner);
    }
    if (code === 36 && source.charCodeAt(index + 1) === 123) {
      hasExpression = true;
      index = scanTemplateExpressionForModuleReferences(source, index + 2, context, state);
      continue;
    }
    index += 1;
  }
  state.tokens.push({ kind: "literal" });
  return scanJavaScriptToken(source, start, state.scanner);
}

function scanModuleSourceToken(
  source: string,
  start: number,
  context: IIdentityContext,
  state: IModuleCanonicalizationState,
): number {
  const code = source.charCodeAt(start);
  if (isWhitespace(code)) {
    if (isLineTerminator(code)) state.scanner.lineTerminatorSinceToken = true;
    return start + 1;
  }
  const skippedComment = commentEnd(source, start);
  if (skippedComment !== undefined) {
    state.scanner.lineTerminatorSinceToken ||= hasLineTerminator(source, start, skippedComment);
    return skippedComment;
  }
  endModuleStatementAtLineBreak(source, start, state);
  if (code === 34 || code === 39) return scanModuleSourceString(source, start, context, state);
  if (isIdentifierStart(code) || isIdentifierEscapeStart(source, start)) {
    return scanModuleSourceIdentifier(source, start, state);
  }
  if (code === 96) return scanModuleSourceTemplate(source, start, context, state);
  if (code === 47 && state.scanner.canStartRegex) {
    state.tokens.push({ kind: "literal" });
    return scanJavaScriptToken(source, start, state.scanner);
  }
  return scanModuleSourcePunctuation(source, start, state);
}

function canonicalizeModuleSource(
  source: string,
  context: IIdentityContext,
  moduleReferences = new Set<string>(),
): string {
  const state: IModuleCanonicalizationState = {
    chunks: [],
    exportDeclarationForm: "unknown",
    moduleStatement: undefined,
    moduleReferences,
    namedClauseDelimiterDepth: undefined,
    outputStart: 0,
    scanner: createScannerState(),
    tokens: [],
  };
  let index = 0;
  while (index < source.length) {
    const nextIndex = scanModuleSourceToken(source, index, context, state);
    if (nextIndex <= index) break;
    index = nextIndex;
  }
  return state.chunks.length === 0
    ? source
    : state.chunks.join("") + source.slice(state.outputStart);
}

function canonicalizeModuleBytes(bytes: Uint8Array, context: IIdentityContext): Uint8Array {
  const source = decoder.decode(bytes);
  const executableSource = stripInlineSourceMapMetadata(source);
  const canonicalSource = canonicalizeModuleSource(executableSource, context);
  return canonicalSource === source ? bytes : encoder.encode(canonicalSource);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareExactStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode < rightCode) return -1;
    if (leftCode > rightCode) return 1;
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
}

function serializeModuleGraph(
  entries: readonly IModuleGraphEntry[],
  contextEntries: readonly IModuleGraphEntry[] = entries,
): Uint8Array {
  if (entries.length === 0) throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:empty graph");
  for (const entry of entries) {
    if (typeof entry.url !== "string" || entry.url.trim().length === 0) {
      throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:missing module URL");
    }
  }
  const context = createIdentityContext(contextEntries);
  const chunks: Uint8Array[] = [encoder.encode("threenative-module-graph-v1\0")];
  const canonicalEntries = entries.map((entry) => ({
    bytes: canonicalizeModuleBytes(entry.bytes, context),
    url: canonicalizeModuleReference(entry.url, context),
  }));
  const observedBytes = new Map<string, Uint8Array>();
  for (const entry of canonicalEntries) {
    const previousBytes = observedBytes.get(entry.url);
    if (previousBytes !== undefined && !bytesEqual(previousBytes, entry.bytes)) {
      throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:conflicting duplicate module URL");
    }
    observedBytes.set(entry.url, previousBytes ?? entry.bytes);
  }
  for (const entry of canonicalEntries.sort((left, right) =>
    compareExactStrings(left.url, right.url),
  )) {
    const url = encoder.encode(entry.url);
    chunks.push(
      encoder.encode(`${url.byteLength}:`),
      url,
      encoder.encode(`${entry.bytes.byteLength}:`),
      entry.bytes,
    );
  }
  return concatenate(chunks);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined)
    throw new Error("TN_BENCH_IDENTITY_HASH_UNAVAILABLE");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashServedModuleGraph(
  entries: readonly IModuleGraphEntry[],
): Promise<string> {
  return sha256(serializeModuleGraph(entries));
}

export async function hashWorkloadModuleGraph(
  entries: readonly IModuleGraphEntry[],
  configuration: unknown,
  contextEntries: readonly IModuleGraphEntry[] = entries,
): Promise<string> {
  return sha256(
    concatenate([
      encoder.encode("threenative-workload-v1\0"),
      serializeModuleGraph(entries, contextEntries),
      encoder.encode(JSON.stringify(configuration)),
    ]),
  );
}

export function extractModuleSpecifiers(source: string): string[] {
  const moduleReferences = new Set<string>();
  canonicalizeModuleSource(stripInlineSourceMapMetadata(source), {}, moduleReferences);
  return [...moduleReferences];
}
