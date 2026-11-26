// Inkling Mini 2 session-trace sharing (PRD-918): finds this project's local agent sessions, keeps
// only those run entirely on an allowlisted frontier model, scrubs each one locally (fail-closed)
// and uploads it only when the developer opted in on this machine. Off by default; dev runs only.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  type IScrubIdentity,
  type ModelFamily,
  localIdentity,
  modelFamily,
  scrubTrace,
} from "./scrub-trace.js";
import { prefsDir, readPrefs } from "./telemetry-prefs.js";

export const TRACE_ENDPOINT = "https://threenative.com/api/telemetry/traces";
/** The Worker refuses bigger envelopes; a trace over this is skipped, not truncated. */
export const MAX_TRACE_BYTES = 10 * 1024 * 1024;

export interface ITraceCandidate {
  readonly id: string;
  readonly agent: "claude" | "codex" | "pi";
  readonly file: string;
  readonly bytes: number;
  readonly models: readonly string[];
  /** The allowlisted family, when every model the session used is in it. */
  readonly family?: ModelFamily;
  /** Why the session will not be shared, when it will not. */
  readonly skip?: string;
  readonly submitted: boolean;
}

interface ISessionHome {
  readonly home: string;
}

/** Claude Code names a project's folder by its path with every non-alphanumeric as `-`. */
const claudeFolder = (root: string) => root.replace(/[^A-Za-z0-9]/gu, "-");
/** pi wraps the same idea in `--…--`, with `/` as `-`. */
const piFolder = (root: string) => `--${root.replace(/^[\\/]/u, "").replace(/[\\/]/gu, "-")}--`;

async function files(dir: string, match: (name: string) => boolean, depth = 0): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) out.push(...(await files(full, match, depth - 1)));
    else if (entry.isFile() && match(entry.name)) out.push(full);
  }
  return out;
}

/** The first `cwd` a session records, and every model id it names. */
async function sessionFacts(file: string): Promise<{ cwd?: string; models: string[] }> {
  const text = await readFile(file, "utf8");
  let cwd: string | undefined;
  const models = new Set<string>();
  const visit = (node: unknown, key = ""): void => {
    if (typeof node === "string") {
      if (!cwd && key === "cwd") cwd = node;
      if ((key === "model" || key === "modelId") && node && node !== "<synthetic>")
        models.add(node);
      return;
    }
    if (Array.isArray(node)) for (const child of node) visit(child);
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) visit(v, k);
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // A torn last line (a session still writing) is not a fact about the session.
    }
  }
  return { ...(cwd ? { cwd } : {}), models: [...models] };
}

const HEAD_BYTES = 64 * 1024;

/**
 * The first `cwd` in a session's first 64 KB. Every agent writes it at the start (Codex in its
 * `session_meta` line), so a session from another project costs one small read, not the whole
 * file: one machine held 6,101 Codex sessions, 9 GB, and full reads took 72 s.
 */
async function headCwd(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    const lines = head.subarray(0, bytesRead).toString("utf8").split("\n");
    if (bytesRead === HEAD_BYTES) lines.pop();
    let cwd: string | undefined;
    const visit = (node: unknown, key = ""): void => {
      if (cwd) return;
      if (typeof node === "string") {
        if (key === "cwd") cwd = node;
      } else if (Array.isArray(node)) for (const child of node) visit(child);
      else if (node && typeof node === "object")
        for (const [k, v] of Object.entries(node)) visit(v, k);
    };
    for (const line of lines) {
      if (cwd) break;
      try {
        visit(JSON.parse(line));
      } catch {
        // A line cut at the 64 KB edge or a torn write is not a fact.
      }
    }
    return cwd;
  } finally {
    await handle.close();
  }
}

async function ledger(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(path.join(prefsDir(), "submitted-traces.json"), "utf8"));
    return new Set(Array.isArray(raw.submitted) ? (raw.submitted as string[]) : []);
  } catch {
    return new Set();
  }
}

async function remember(ids: Set<string>): Promise<void> {
  const file = path.join(prefsDir(), "submitted-traces.json");
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ submitted: [...ids] }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/**
 * This project's sessions from Claude Code, Codex and pi. A session counts only when its recorded
 * working directory is the project root (or inside it); Antigravity transcripts record none, so
 * they are never candidates.
 */
export async function discoverTraces(
  root: string,
  where: ISessionHome = { home: os.homedir() },
): Promise<ITraceCandidate[]> {
  const project = path.resolve(root);
  const inProject = (cwd: string | undefined) =>
    cwd !== undefined &&
    (path.resolve(cwd) === project || path.resolve(cwd).startsWith(`${project}${path.sep}`));
  const sources: [ITraceCandidate["agent"], string[]][] = [
    [
      "claude",
      await files(path.join(where.home, ".claude/projects", claudeFolder(project)), (n) =>
        n.endsWith(".jsonl"),
      ),
    ],
    [
      "codex",
      await files(
        path.join(where.home, ".codex/sessions"),
        (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"),
        3,
      ),
    ],
    [
      "pi",
      await files(path.join(where.home, ".pi/agent/sessions", piFolder(project)), (n) =>
        n.endsWith(".jsonl"),
      ),
    ],
  ];
  const done = await ledger();
  const out: ITraceCandidate[] = [];
  for (const [agent, list] of sources) {
    for (const file of list) {
      if (!inProject(await headCwd(file))) continue;
      const bytes = (await stat(file)).size;
      // An oversize session is never shared, so its models are not worth a full read.
      const facts = bytes > MAX_TRACE_BYTES ? { models: [] } : await sessionFacts(file);
      const families = facts.models.map(modelFamily);
      const family = families[0];
      const id = `${agent}:${path.basename(file, ".jsonl")}`;
      let skip: string | undefined;
      if (bytes > MAX_TRACE_BYTES) skip = "over 10 MB";
      else if (facts.models.length === 0) skip = "no model recorded";
      else if (families.some((f) => f === undefined))
        skip = `uses a model outside opus/astra/neon/fable (${facts.models.filter((m) => !modelFamily(m)).join(", ")})`;
      else if (new Set(families).size > 1) skip = "mixes model families";
      out.push({
        id,
        agent,
        file,
        bytes,
        models: facts.models,
        ...(skip === undefined && family ? { family } : {}),
        ...(skip ? { skip } : {}),
        submitted: done.has(id),
      });
    }
  }
  return out;
}

export interface ITracePreview {
  readonly id: string;
  readonly family: ModelFamily;
  readonly records: number;
  readonly redactions: number;
  readonly bytes: number;
  /** The first scrubbed records, shortened, exactly as they would be sent. */
  readonly sample: readonly string[];
  readonly aborted?: string;
}

/** A dry run: what one eligible trace looks like after scrubbing. Sends nothing. */
export async function previewTrace(
  candidate: ITraceCandidate,
  identity: IScrubIdentity = localIdentity(),
): Promise<ITracePreview> {
  if (!candidate.family) throw new Error(`${candidate.id} is not eligible: ${candidate.skip}`);
  try {
    const scrubbed = scrubTrace(await readFile(candidate.file, "utf8"), identity);
    return {
      id: candidate.id,
      family: candidate.family,
      records: scrubbed.records,
      redactions: scrubbed.redactions,
      bytes: Buffer.byteLength(scrubbed.jsonl),
      sample: scrubbed.jsonl
        .split("\n")
        .filter(Boolean)
        .slice(0, 6)
        .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)),
    };
  } catch (error) {
    return {
      id: candidate.id,
      family: candidate.family,
      records: 0,
      redactions: 0,
      bytes: 0,
      sample: [],
      aborted: (error as Error).message,
    };
  }
}

export interface IShareReport {
  readonly sent: string[];
  readonly aborted: { id: string; reason: string }[];
  readonly failed: { id: string; reason: string }[];
  skipped: number;
}

/**
 * Uploads every eligible, not-yet-sent trace. Sends nothing unless `shareSessionTraces` is on in
 * this machine's consent file; a trace whose scrub aborts sends zero bytes.
 */
export async function shareTraces(
  root: string,
  options: {
    readonly fetch?: typeof fetch;
    readonly endpoint?: string;
    readonly identity?: IScrubIdentity;
    readonly where?: ISessionHome;
    readonly engineVersion?: string;
  } = {},
): Promise<IShareReport> {
  const report: IShareReport = { sent: [], aborted: [], failed: [], skipped: 0 };
  if (!(await readPrefs()).shareSessionTraces) return report;
  const send = options.fetch ?? fetch;
  const done = await ledger();
  for (const candidate of await discoverTraces(root, options.where)) {
    if (!candidate.family || done.has(candidate.id)) {
      report.skipped += 1;
      continue;
    }
    let body: Buffer;
    try {
      body = gzipSync(
        scrubTrace(await readFile(candidate.file, "utf8"), options.identity ?? localIdentity())
          .jsonl,
      );
    } catch (error) {
      report.aborted.push({ id: candidate.id, reason: (error as Error).message });
      continue;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    try {
      const response = await send(options.endpoint ?? TRACE_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          "x-tn-model-family": candidate.family,
          "x-tn-agent": candidate.agent,
          "x-tn-trace-sha256": sha256,
          ...(options.engineVersion ? { "x-tn-engine": options.engineVersion } : {}),
        },
        body: new Uint8Array(body),
      });
      // 409: the site already holds this exact trace, so it counts as shared.
      if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
      done.add(candidate.id);
      report.sent.push(candidate.id);
    } catch (error) {
      report.failed.push({ id: candidate.id, reason: (error as Error).message });
    }
  }
  if (report.sent.length > 0) await remember(done);
  return report;
}
