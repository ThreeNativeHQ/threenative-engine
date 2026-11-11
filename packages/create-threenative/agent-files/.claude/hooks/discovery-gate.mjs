#!/usr/bin/env node
// Discovery gate (PRD-827). Each user prompt records its time; the first new file under `src/`
// after it is blocked until `.threenative/engine-mcp.log` holds an `engine_search_capabilities`
// line newer than that prompt. The engine server writes the log for MCP and `call.mjs` calls
// alike, so one script serves Claude Code and Codex. Edits to existing files pass.
// `TN_DISCOVERY_GATE=off` opts out and says so once per session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEARCH =
  'mcp__threenative-engine__engine_search_capabilities {"situation": "<the mechanic or change>", "scope": "mechanic"}';
const BRIDGE =
  'node node_modules/@threenative/core/mcp/call.mjs threenative-engine engine_search_capabilities \'{"situation":"<the mechanic or change>"}\'';

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Every path the tool call creates: `file_path`/`path` (Write, Edit) or `*** Add File:` lines
 * in any string of the input (Codex `apply_patch`). */
function targets(input) {
  const found = [];
  const visit = (value) => {
    if (typeof value === "string")
      for (const match of value.matchAll(/^\*\*\* Add File: (.+)$/gmu)) found.push(match[1].trim());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  if (input && typeof input === "object") {
    for (const key of ["file_path", "path"])
      if (typeof input[key] === "string") found.push(input[key]);
  }
  visit(input);
  return found;
}

function newSourceFiles(root, input) {
  return targets(input)
    .map((file) => path.resolve(root, file))
    .filter((absolute) => !existsSync(absolute))
    .map((absolute) => path.relative(root, absolute).split(path.sep).join("/"))
    .filter((relative) => relative.startsWith("src/"));
}

function respond(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function deny(reason) {
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function searchedSince(log, since) {
  return log.split("\n").some((line) => {
    if (!line.includes("engine_search_capabilities")) return false;
    try {
      const entry = JSON.parse(line);
      return entry.tool === "engine_search_capabilities" && Date.parse(entry.time) > since;
    } catch {
      return false;
    }
  });
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const stateFile = path.join(root, ".threenative", "discovery-gate.json");
const state = readJson(stateFile, {});
const save = (next) => {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(next)}\n`);
};

if (input.hook_event_name === "UserPromptSubmit") {
  save({ ...state, prompt: new Date().toISOString() });
  process.exit(0);
}
if (input.hook_event_name !== "PreToolUse") process.exit(0);
const created = newSourceFiles(root, input.tool_input);
if (created.length === 0) process.exit(0);

if (process.env.TN_DISCOVERY_GATE === "off") {
  if (state.optOutSession !== input.session_id) {
    save({ ...state, optOutSession: input.session_id });
    respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "TN_DISCOVERY_GATE=off: the discovery gate is off for this session, so new src/ files are written without an engine capability search. Report this opt-out to the user.",
      },
    });
  }
  process.exit(0);
}

const logFile = path.join(root, ".threenative", "engine-mcp.log");
let log;
try {
  log = readFileSync(logFile, "utf8");
} catch (error) {
  deny(
    `Discovery gate: cannot read ${path.relative(root, logFile)} (${error.code ?? error.message}), so the engine was not searched in this project. Before you create ${created.join(", ")}, run ${SEARCH} and read every row; engine_capability_detail is only for a symbol the search did not return. Outside this folder: ${BRIDGE}. Opt out with TN_DISCOVERY_GATE=off.`,
  );
  process.exit(0);
}
const since = Date.parse(state.prompt ?? "") || 0;
if (!searchedSince(log, since))
  deny(
    `Discovery gate: no engine_search_capabilities call since the last user prompt. Before you create ${created.join(", ")}, run ${SEARCH} and read every row — engine_capability_detail is only for a symbol the search did not return — and use what it returns. Outside this folder: ${BRIDGE}. Opt out with TN_DISCOVERY_GATE=off.`,
  );
