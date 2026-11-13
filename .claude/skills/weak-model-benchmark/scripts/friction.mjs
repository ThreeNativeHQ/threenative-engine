#!/usr/bin/env node
// Friction meter for one leanpi builder session.
// Usage: node friction.mjs <session.jsonl>  -> prints friction JSON, exit 1 when the run is VOID.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node friction.mjs <session.jsonl>");
const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
if (entries.length === 0) throw new Error(`Empty session log: ${file}`);

const ARM_PROVIDER = "opencode-go";
const ARM_MODEL = "deepseek-v4.1-flash";
const models = entries.filter((e) => e.type === "model_change").map((e) => `${e.provider}/${e.modelId}`);
const thinking = entries.filter((e) => e.type === "thinking_level_change").map((e) => e.thinkingLevel);
const voidReasons = [];
if (models.length === 0) voidReasons.push("no model_change entry");
for (const m of new Set(models)) if (m !== `${ARM_PROVIDER}/${ARM_MODEL}`) voidReasons.push(`ran on ${m}`);
if (thinking.at(-1) !== "max") voidReasons.push(`thinking level ${thinking.at(-1) ?? "unset"}, expected max`);

const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content ?? []).filter((c) => c.type === "toolCall"));
const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
const text = (c) => JSON.stringify(c.arguments ?? {});
const index = (pred) => {
  const i = calls.findIndex(pred);
  return i < 0 ? null : i + 1;
};

const writesSrc = (c) => /^(write|edit)$/.test(c.name) && /(^|\/)src\//.test(c.arguments?.path ?? c.arguments?.file_path ?? "");
const searches = (c) => /engine_search_capabilities|engine_capability_detail/.test(c.name);
const firstSrcWrite = index(writesSrc);
const usage = messages.filter((m) => m.role === "assistant" && m.usage).map((m) => m.usage);

const report = {
  session: file,
  verdict: voidReasons.length ? "VOID" : "VALID",
  voidReasons,
  toolCalls: calls.length,
  firstSrcWriteAt: firstSrcWrite,
  capabilitySearches: calls.filter(searches).length,
  capabilitySearchesBeforeFirstWrite: calls.slice(0, firstSrcWrite ?? calls.length).filter(searches).length,
  toolErrors: calls.filter((c) => results.get(c.id)?.isError).length,
  // Reading package internals means the public surface (manifest, kit docs, types) did not answer.
  packageInternalReads: calls.filter((c) => /node_modules\/@?threenative[^"]*\/(src|dist)\//.test(text(c))).length,
  typecheckRuns: calls.filter((c) => c.name === "bash" && /\b(tsc|typecheck)\b/.test(text(c))).length,
  playtestRuns: calls.filter((c) => c.name === "bash" && /playtest/.test(text(c))).length,
  outputTokens: usage.reduce((sum, u) => sum + (u.output ?? 0), 0),
  costUsd: Number(usage.reduce((sum, u) => sum + (u.cost?.total ?? 0), 0).toFixed(4)),
  stopReason: messages.filter((m) => m.role === "assistant").at(-1)?.stopReason ?? null,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.verdict === "VOID" ? 1 : 0);
