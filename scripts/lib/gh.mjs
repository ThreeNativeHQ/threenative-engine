// One `gh` call for the CI scripts, because four of them each had their own rule: one threw on a
// non-zero exit, one only looked at stdout, one trimmed and one did not, and a failed query could
// read as an empty answer. A read is retried once — GitHub answers 5xx under load, and a lane that
// dies on that is a red nobody can act on — while a call that changes state never is: a retry can
// apply it twice.
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

/**
 * Runs `gh` and returns its stdout, or throws with `gh`'s own stderr.
 *
 * @param {readonly string[]} args
 * @param {{ readonly retries?: number }} [options] `retries` defaults to 1 for a read, 0 for a write.
 * @returns {string}
 */
export function gh(args, options = {}) {
  const retries = options.retries ?? (isRepeatableRead(args) ? 1 : 0);
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
    } catch (error) {
      last = String(error?.stderr ?? "").trim() || (error instanceof Error ? error.message : "");
    }
  }
  throw new Error(`${label(args)} failed after ${String(retries + 1)} attempt(s): ${last}`);
}
