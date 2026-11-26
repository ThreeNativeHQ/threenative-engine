// The session-trace scrubber (PRD-918). It runs on the developer's machine before any byte leaves
// it: every string in every JSONL record is decoded, scrubbed of secrets and personal data, and the
// result is re-scanned. Any survivor aborts the whole trace (`TN_TRACE_SCRUB_ABORTED`) and nothing
// is sent. Over-redaction is the accepted failure mode; a leak is not.
import os from "node:os";

export const SCRUB_ABORTED = "TN_TRACE_SCRUB_ABORTED";

export class TraceScrubAbort extends Error {
  readonly code = SCRUB_ABORTED;
  constructor(readonly finding: string) {
    super(`${SCRUB_ABORTED}: a ${finding} survived scrubbing; nothing was sent.`);
  }
}

export interface IScrubIdentity {
  readonly home: string;
  readonly username: string;
  readonly hostname: string;
}

export function localIdentity(): IScrubIdentity {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? process.env.USERNAME ?? "";
  }
  return { home: os.homedir(), username, hostname: os.hostname() };
}

const R = "[redacted]";

/** Token and key shapes: the union of the site's store-secrets rules and the dataset builder's. */
const SECRET_SHAPES: readonly [string, RegExp][] = [
  [
    "private key block",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu,
  ],
  ["AWS key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/gu],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu],
  ["Stripe key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/gu],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/gu],
  ["OpenAI-style key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/gu],
  ["Google key", /\bAIza[0-9A-Za-z_-]{30,}/gu],
  ["Slack token", /\bxox[abposre]-[A-Za-z0-9-]{10,}/gu],
  ["HuggingFace token", /\bhf_[A-Za-z0-9]{20,}/gu],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}/gu],
  ["JWT", /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu],
  [
    "authorization header",
    /\b(?:Proxy-)?Authorization\b["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Digest)\s+(?!\[redacted)[^\s"'\\,;]+/giu,
  ],
  ["bearer token", /\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{16,}/giu],
  ["URL credentials", /\b[a-z][a-z0-9+.-]*:\/\/(?!\[redacted)[^\s:/@"'\\]+:[^\s@/"'\\]+@/giu],
  [
    "secret assignment",
    /\b(?:[A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PAT|APIKEY|API_KEY)|DATABASE_URL|PASSWORD|SECRET)\b["']?\s*[:=]\s*["']?(?!\[redacted)(?=[^\s"'\\,;}]{6,})[^\s"'\\,;}]+/giu,
  ],
  ["cookie header", /\b(?:Set-)?Cookie\b["']?\s*:\s*["']?(?!\[redacted)[^\n"\\]{4,}/giu],
];

const SENSITIVE_FILE =
  /(?:^|[\\/\s"'`=])(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.(?:pem|p12|pfx|key)|id_rsa[\w.-]*|id_ed25519[\w.-]*|id_ecdsa[\w.-]*|auth\.json|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?|\.ssh[\\/][^\s"']*)(?=$|[\s"'`;|)&\\,:])/iu;

/** True when a path or command names a file whose body must never leave the machine. */
export function isSensitiveFile(text: string): boolean {
  return SENSITIVE_FILE.test(text) || /\.aws[\\/]credentials/u.test(text);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function redactSecrets(text: string): string {
  let out = text;
  for (const [name, shape] of SECRET_SHAPES) {
    out = out.replace(shape, (match) => {
      if (name === "URL credentials") return match.replace(/\/\/[^@]+@/u, `//${R}@`);
      if (
        name === "secret assignment" ||
        name === "authorization header" ||
        name === "cookie header"
      ) {
        const cut = match.search(/[:=]/u);
        const head = match.slice(0, cut + 1);
        return `${head}${R}`;
      }
      return R;
    });
  }
  return out;
}

const IPV4 =
  /\b(?!127\.)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu;
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}\b/giu;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const USER_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:\\{1,2}Users\\{1,2})(?!<user>)[^\\/\s"'`]+/gu;
const QUERY_SECRET =
  /([?&](?:token|key|secret|sig|signature|password|access_token|api_key|apikey|auth|code)=)(?!\[redacted)[^&\s"'#\\]+/giu;

function identityPatterns(identity: IScrubIdentity): [RegExp, string][] {
  const out: [RegExp, string][] = [];
  if (identity.home.length > 1) out.push([new RegExp(escapeRegExp(identity.home), "gu"), "~"]);
  if (identity.hostname.length >= 3)
    out.push([new RegExp(`\\b${escapeRegExp(identity.hostname)}\\b`, "giu"), "<host>"]);
  if (identity.username.length >= 3)
    out.push([new RegExp(`\\b${escapeRegExp(identity.username)}\\b`, "giu"), "<user>"]);
  return out;
}

/** Scrubs one decoded string. */
export function scrubText(text: string, identity: IScrubIdentity = localIdentity()): string {
  // Emails first: a username rewrite would turn alice@acme.com into <user>@acme.com, which no
  // longer reads as an email and would ship the domain.
  let out = redactSecrets(text).replace(EMAIL, "<email>");
  for (const [pattern, replacement] of identityPatterns(identity))
    out = out.replace(pattern, replacement);
  out = out.replace(USER_PATH, (match) => match.replace(/[^\\/]+$/u, "<user>"));
  out = out.replace(IPV4, "<ip>");
  out = out.replace(IPV6, (match) => (match === "::1" ? match : "<ip>"));
  out = out.replace(QUERY_SECRET, `$1${R}`);
  return out;
}

/** The first secret or identity that is still present in `text`, or undefined. */
export function residualFinding(
  text: string,
  identity: IScrubIdentity = localIdentity(),
): string | undefined {
  for (const [name, shape] of SECRET_SHAPES) {
    shape.lastIndex = 0;
    if (shape.test(text)) {
      shape.lastIndex = 0;
      return name;
    }
  }
  for (const [pattern, replacement] of identityPatterns(identity)) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return replacement === "~" ? "home directory" : replacement;
  }
  USER_PATH.lastIndex = 0;
  if (USER_PATH.test(text)) return "user path";
  EMAIL.lastIndex = 0;
  if (EMAIL.test(text)) return "email address";
  for (const [name, shape] of [
    ["IP address", IPV4],
    ["IP address", IPV6],
    ["URL query secret", QUERY_SECRET],
  ] as const) {
    shape.lastIndex = 0;
    if (shape.test(text)) return name;
  }
  return undefined;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const PRIVATE_FILE = "[redacted: private file]";
const SECRET_KEY =
  /^(?:(?:set-)?cookie|(?:proxy-)?authorization|password|passwd|secret|api_?key|access_token|refresh_token|database_url|[a-z0-9_]*_(?:key|token|secret|password|passwd))$/iu;
const BODY_KEYS = new Set([
  "content",
  "text",
  "output",
  "stdout",
  "stderr",
  "result",
  "new_string",
  "old_string",
  "file_text",
  "data",
]);
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "path",
  "filename",
  "file",
  "notebook_path",
  "command",
  "cmd",
]);

/** The keys each agent uses to link a tool result to its call (Codex, Claude Code, pi, OpenAI). */
const LINK_KEYS = ["tool_use_id", "call_id", "tool_call_id", "toolCallId"] as const;

/** Every string inside a tool input, with JSON-encoded strings (Codex `arguments`) decoded. */
function inputStrings(input: Json, out: string[] = []): string[] {
  if (typeof input === "string") {
    out.push(input);
    if (/^\s*[[{]/u.test(input))
      try {
        inputStrings(JSON.parse(input) as Json, out);
      } catch {
        // Not JSON: the raw string above is already tested.
      }
  } else if (Array.isArray(input)) for (const child of input) inputStrings(child, out);
  else if (input && typeof input === "object")
    for (const value of Object.values(input)) inputStrings(value, out);
  return out;
}

/** True when this record answers a private call anywhere inside it. */
function answersPrivate(node: Json, privateIds: Set<string>): boolean {
  if (Array.isArray(node)) return node.some((child) => answersPrivate(child, privateIds));
  if (node === null || typeof node !== "object") return false;
  if (LINK_KEYS.some((key) => typeof node[key] === "string" && privateIds.has(node[key] as string)))
    return true;
  return Object.values(node).some((child) => answersPrivate(child, privateIds));
}

/** Tool calls that read or print a private file: their results are dropped whole. */
function privateToolIds(records: Json[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: Json): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const input = node.input ?? node.arguments ?? node.args;
    if (input !== undefined && inputStrings(input).some(isSensitiveFile))
      // A Codex call carries both `id` and `call_id`; its output links by `call_id`.
      for (const key of ["id", ...LINK_KEYS])
        if (typeof node[key] === "string") ids.add(node[key] as string);
    for (const value of Object.values(node)) visit(value);
  };
  records.forEach(visit);
  return ids;
}

function scrubNode(node: Json, identity: IScrubIdentity, privateIds: Set<string>): Json {
  if (typeof node === "string") return scrubText(node, identity);
  if (Array.isArray(node)) return node.map((child) => scrubNode(child, identity, privateIds));
  if (node === null || typeof node !== "object") return node;
  const linked =
    !("input" in node || "arguments" in node) &&
    LINK_KEYS.some((key) => typeof node[key] === "string" && privateIds.has(node[key] as string));
  const namesPrivate = Object.entries(node).some(
    ([key, value]) => PATH_KEYS.has(key) && typeof value === "string" && isSensitiveFile(value),
  );
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if ((linked || namesPrivate) && BODY_KEYS.has(key)) out[key] = PRIVATE_FILE;
    // A JSON header or env map holds the secret as the value of a named key.
    else if (SECRET_KEY.test(key) && typeof value === "string" && value.length > 0) out[key] = R;
    else out[scrubText(key, identity)] = scrubNode(value, identity, privateIds);
  }
  return out;
}

export interface IScrubResult {
  /** The scrubbed JSONL, one record per line. */
  readonly jsonl: string;
  readonly records: number;
  /** Lines that were not JSON and were dropped. */
  readonly dropped: number;
  readonly redactions: number;
}

/**
 * Scrubs a JSONL trace and re-scans the result. Throws `TraceScrubAbort` if anything a scrub
 * should have caught is still there; the caller then sends nothing.
 */
export function scrubTrace(
  jsonl: string,
  identity: IScrubIdentity = localIdentity(),
): IScrubResult {
  const records: Json[] = [];
  let dropped = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Json);
    } catch {
      dropped += 1;
    }
  }
  const privateIds = privateToolIds(records);
  const lines = records.map((record) => {
    const scrubbed = scrubNode(record, identity, privateIds);
    // Claude Code copies a tool's stdout into a sibling `toolUseResult` that carries no id.
    if (
      scrubbed &&
      typeof scrubbed === "object" &&
      !Array.isArray(scrubbed) &&
      "toolUseResult" in scrubbed &&
      answersPrivate(record, privateIds)
    )
      scrubbed.toolUseResult = PRIVATE_FILE;
    return JSON.stringify(scrubbed);
  });
  const out = lines.join("\n");
  // The re-scan reads both the serialized text and every decoded string, so neither a JSON escape
  // nor a value split across escapes hides a survivor.
  const decoded: string[] = [];
  const collect = (node: Json): void => {
    if (typeof node === "string") decoded.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) {
        decoded.push(k);
        collect(v);
      }
  };
  for (const line of lines) collect(JSON.parse(line) as Json);
  const finding = residualFinding(out, identity) ?? residualFinding(decoded.join("\n"), identity);
  if (finding) throw new TraceScrubAbort(finding);
  const redactions = (out.match(/\[redacted|<user>|<host>|<email>|<ip>|~\//gu) ?? []).length;
  return { jsonl: out ? `${out}\n` : "", records: records.length, dropped, redactions };
}

/** The four allowlisted model families; anything else (or nothing) is never uploaded. */
export const MODEL_FAMILIES = ["opus", "astra", "neon", "fable"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** `claude-opus-5-5` → `opus`; `gemini-4-neon-high` → `neon`; `deepseek-v4` / `haiku` → undefined. */
export function modelFamily(model: string | undefined): ModelFamily | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  if (/\b(?:inkling|deepseek|haiku|mini|flash)\b/u.test(id)) return undefined;
  return MODEL_FAMILIES.find((family) => new RegExp(`\\b${family}\\b`, "u").test(id));
}
