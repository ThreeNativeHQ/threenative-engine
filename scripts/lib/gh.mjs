// One `gh` call for the CI scripts, because four of them each had their own rule: one threw on a
// non-zero exit, one only looked at stdout, one trimmed and one did not, and a failed query could
// read as an empty answer. A read is retried once — GitHub answers 5xx under load, and a lane that
// dies on that is a red nobody can act on — while a call that changes state never is: a retry can
// apply it twice.
import { execFileSync } from "node:child_process";

/** Board and log queries return megabytes of JSON; the default 1 MB buffer truncates them. */
const MAX_BUFFER = 512 * 1024 * 1024;

/** Subcommands that change GitHub state, so a retry could apply the change twice. */
const MUTATING_SUBCOMMANDS = new Set([
  "cancel",
  "close",
  "comment",
  "create",
  "delete",
  "edit",
  "enable",
  "disable",
  "merge",
  "ready",
  "rename",
  "rerun",
  "review",
  "unlock",
  "update",
]);

/** Whether `args` reaches a write: a mutating subcommand, or an `api` call that sends a body or a method. */
function changesState(args) {
  if (MUTATING_SUBCOMMANDS.has(args[1])) return true;
  if (args[0] !== "api") return false;
  return args.some(
    (arg) =>
      arg === "-f" ||
      arg === "-F" ||
      arg === "--field" ||
      (arg === "-X" && args[args.indexOf(arg) + 1] !== "GET") ||
      arg === "--input",
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
  const retries = options.retries ?? (changesState(args) ? 0 : 1);
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
