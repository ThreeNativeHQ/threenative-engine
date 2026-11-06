import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

// PRD-827 AC-5/AC-6: the discovery gate blocks the first new src/ file after a user prompt until
// the engine log holds a capability search newer than that prompt. Driven exactly as a host does:
// the hook input on stdin, the decision on stdout.
const agentFiles = path.resolve("packages/create-threenative/agent-files");
const script = path.join(agentFiles, ".claude/hooks/discovery-gate.mjs");
let root: string;

function hook(input: Record<string, unknown>, env: Record<string, string> = {}) {
  const stdout = execFileSync(process.execPath, [script], {
    input: JSON.stringify({ cwd: root, session_id: "s1", ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", TN_DISCOVERY_GATE: "", ...env },
    encoding: "utf8",
  });
  return stdout.trim() === "" ? undefined : JSON.parse(stdout);
}

const prompt = () => hook({ hook_event_name: "UserPromptSubmit", prompt: "add a double jump" });
const write = (file = "src/DoubleJump.ts", env?: Record<string, string>) =>
  hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, file), content: "x" },
    },
    env,
  );
const decision = (output: { hookSpecificOutput?: { permissionDecision?: string } } | undefined) =>
  output?.hookSpecificOutput?.permissionDecision ?? "allow";

function logSearch(time: Date, tool = "engine_search_capabilities"): void {
  mkdirSync(path.join(root, ".threenative"), { recursive: true });
  writeFileSync(
    path.join(root, ".threenative/engine-mcp.log"),
    `${JSON.stringify({ time: time.toISOString(), tool, situation: "double jump" })}\n`,
    { flag: "a" },
  );
}

beforeEach(() => {
  root = makeTempDirSync("discovery-gate-");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/game.ts"), "export {};\n");
});

describe("discovery gate (Claude Code)", () => {
  it("blocks a new src/ file when the log has no capability search", () => {
    logSearch(new Date(), "engine_capability_detail");
    prompt();
    const output = write();
    expect(decision(output)).toBe("deny");
    const reason = output.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("mcp__threenative-engine__engine_search_capabilities");
    expect(reason).toContain("node_modules/@threenative/core/mcp/call.mjs");
  });

  it("blocks when the only search is older than the last prompt", () => {
    logSearch(new Date(Date.now() - 60_000));
    prompt();
    expect(decision(write())).toBe("deny");
  });

  it("passes once a search is newer than the last prompt", () => {
    prompt();
    logSearch(new Date(Date.now() + 1_000));
    expect(decision(write())).toBe("allow");
  });

  it("passes an edit of an existing file and a new file outside src/", () => {
    prompt();
    expect(decision(write("src/game.ts"))).toBe("allow");
    expect(decision(write("playtests/jump.playtest.json"))).toBe("allow");
  });

  it("opts out with TN_DISCOVERY_GATE=off and reports it once per session", () => {
    prompt();
    const first = write("src/A.ts", { TN_DISCOVERY_GATE: "off" });
    expect(decision(first)).toBe("allow");
    expect(first.hookSpecificOutput.additionalContext).toContain("TN_DISCOVERY_GATE=off");
    expect(write("src/B.ts", { TN_DISCOVERY_GATE: "off" })).toBeUndefined();
  });

  it("blocks with the reason when the log is missing", () => {
    prompt();
    const output = write();
    expect(decision(output)).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "cannot read .threenative/engine-mcp.log",
    );
  });

  it("is wired into the scaffold settings for Write, Edit and the prompt", () => {
    const settings = JSON.parse(
      readFileSync(path.join(agentFiles, ".claude/settings.json"), "utf8"),
    );
    const commands = (event: string) =>
      (settings.hooks[event] as { matcher?: string; hooks: { command: string }[] }[]).flatMap(
        (group) => group.hooks.map((entry) => `${group.matcher ?? ""} ${entry.command}`),
      );
    expect(commands("PreToolUse").join("\n")).toMatch(/Write\|Edit.*discovery-gate\.mjs/u);
    expect(commands("UserPromptSubmit").join("\n")).toContain("discovery-gate.mjs");
  });
});

describe("discovery gate (Codex)", () => {
  // Codex 0.167 `pre-tool-use.command.input`: the same fields plus turn_id, model and
  // permission_mode; a file is created through apply_patch, whose patch names it.
  const codex = (patch: string) =>
    hook({
      hook_event_name: "PreToolUse",
      model: "gpt",
      permission_mode: "default",
      tool_name: "apply_patch",
      tool_input: { command: patch },
      tool_use_id: "t1",
      transcript_path: null,
      turn_id: "u1",
    });
  const addFile = "*** Begin Patch\n*** Add File: src/DoubleJump.ts\n+export {};\n*** End Patch\n";

  it("blocks an apply_patch that adds a src/ file until a search is newer than the prompt", () => {
    prompt();
    expect(decision(codex(addFile))).toBe("deny");
    logSearch(new Date(Date.now() + 1_000));
    expect(decision(codex(addFile))).toBe("allow");
  });

  it("passes an apply_patch that only updates an existing file", () => {
    prompt();
    expect(
      decision(codex("*** Begin Patch\n*** Update File: src/game.ts\n@@\n-x\n+y\n*** End Patch\n")),
    ).toBe("allow");
  });

  it("is wired into the scaffold Codex hooks", () => {
    const hooks = readFileSync(path.join(agentFiles, ".codex/hooks.json"), "utf8");
    expect(hooks).toContain("discovery-gate.mjs");
    expect(hooks).toContain("apply_patch");
  });
});
