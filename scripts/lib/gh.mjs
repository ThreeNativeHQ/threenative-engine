// One `gh` call for the CI scripts, because four of them each had their own rule: one threw on a
// non-zero exit, one only looked at stdout, one trimmed and one did not, and a failed query could
// read as an empty answer. A read is retried twice with a backoff — GitHub answers 5xx under load,
// and one HTTP 502 turned the 0.3.19 main push from a 1-minute reuse into a 55-minute board
// (PRD-903) — while a call that changes state never is: a retry can apply it twice. A 4xx answer is
// final, so it is not retried.
import { execFileSync } from "node:child_process";

/** Board and log queries return megabytes of JSON; the default 1 MB buffer truncates them. */
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * The read shapes a CI lane repeats safely: `gh <verb> <sub>` pairs this repository's scripts use to
 * ask a question. Everything else — a write, a dispatch, a download, a subcommand added tomorrow —
 * is sent once, because a retry can apply a change twice and a deny-list cannot see what it has
 * never heard of.
 */
const RETRYABLE = new Set([
  "issue list",
  "issue view",
  "pr checks",
  "pr list",
  "pr view",
  "release list",
  "release view",
  "repo view",
  "run list",
  "run view",
  "search prs",
  "search issues",
  "workflow list",
  "workflow view",
]);

/** Whether `args` is a read this wrapper may repeat: an allow-listed pair, and not an `api` write. */
function isRepeatableRead(args) {
  // `gh api <path>` is a read unless it carries a body or a method; every other verb has to name a
  // subcommand this repository's scripts already ask with.
  if (args[0] !== "api" && !RETRYABLE.has(`${args[0]} ${args[1]}`)) return false;
  if (args[0] !== "api") return true;
  // `gh api` is a read unless it carries a body or a method. Every spelling counts here, including
  // the joined forms (`--method=POST`, `-XPOST`) and `--raw-field`/`--input`.
  return !args.some(
    (arg, index) =>
      arg === "-f" ||
      arg === "-F" ||
      arg === "--field" ||
      arg === "--raw-field" ||
      arg === "--input" ||
      arg.startsWith("--field=") ||
      arg.startsWith("--raw-field=") ||
      arg.startsWith("--input=") ||
      arg.startsWith("--method=") ||
      /^-X/u.test(arg) ||
      (arg === "-X" && (args[index + 1] ?? "GET") !== "GET") ||
      (arg === "--method" && (args[index + 1] ?? "GET") !== "GET"),
  );
}

/** The command as a reader typed it, for an error that names what failed. */
function label(args) {
  return `gh ${args.slice(0, 2).join(" ")}`;
}

/** A synchronous pause: every caller of this wrapper is synchronous. */
function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The first wait between read attempts; `TN_GH_RETRY_DELAY_MS=0` makes specs instant. */
function retryDelayMs() {
  const raw = Number(process.env.TN_GH_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

/**
 * Runs `gh` and returns its stdout, or throws with `gh`'s own stderr.
 *
 * @param {readonly string[]} args
 * @param {{ readonly retries?: number }} [options] `retries` defaults to 2 for a read, 0 for a write.
 * @returns {string}
 */
export function gh(args, options = {}) {
  const retries = options.retries ?? (isRepeatableRead(args) ? 2 : 0);
  let last = "";
  let attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) sleep(retryDelayMs() * 3 ** (attempt - 1));
    attempts += 1;
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
    } catch (error) {
      last = String(error?.stderr ?? "").trim() || (error instanceof Error ? error.message : "");
      // A 4xx is the server's final answer (missing run, no permission): asking again changes nothing.
      if (/\bHTTP 4\d\d\b/u.test(last)) break;
    }
  }
  throw new Error(`${label(args)} failed after ${String(attempts)} attempt(s): ${last}`);
}
