#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
// Installing ThreeNative wires its MCP servers into the project. An agent authoring a game here
// should not have to be told the asset, sculpt and capability tools exist, or run a setup command
// to get them. Every host that reads a project-scoped MCP config gets one — `MCP_HOSTS` is the
// list. Set THREENATIVE_SKIP_MCP_SETUP=1 to opt out.
import {
  MCP_HOSTS,
  ensureHostMcpConfigs,
  ensureLeanpiSchemaCache,
  installTarget,
} from "../mcp/install.mjs";

const LABELS = new Map(MCP_HOSTS.map((host) => [host.id, host.label]));

export async function runMcpSetup(environment = process.env, cwd = process.cwd()) {
  const skip = environment.THREENATIVE_SKIP_MCP_SETUP;
  if (skip === "1" || skip === "true") return;
  // Never fail an install over this. A game that cannot write its MCP configs still runs.
  try {
    const target = installTarget(environment, cwd);
    if (target === undefined) return;
    const outcomes = ensureHostMcpConfigs(target);
    // Loaded here, not in install.mjs: the scaffolder bundles install.mjs, and a bundled copy of
    // the server would start itself under the scaffolder's own entry path.
    const { toolDefinitions } = await import("../mcp/engine-server.mjs");
    ensureLeanpiSchemaCache(target, toolDefinitions());
    const wired = [...outcomes]
      .filter(([, outcome]) => outcome === "created" || outcome === "updated")
      .map(([id]) => LABELS.get(id) ?? id);
    if (wired.length > 0) {
      process.stdout.write(
        `threenative: wired the ThreeNative MCP servers for ${wired.join(", ")}\n`,
      );
    }
    const unreadable = [...outcomes]
      .filter(([, outcome]) => outcome === "unreadable")
      .map(([id]) => LABELS.get(id) ?? id);
    if (unreadable.length > 0) {
      process.stdout.write(
        `threenative: left ${unreadable.join(", ")} alone; its config is not valid JSON\n`,
      );
    }
  } catch (error) {
    process.stdout.write(`threenative: could not wire the MCP configs (${error})\n`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url)
  await runMcpSetup();
