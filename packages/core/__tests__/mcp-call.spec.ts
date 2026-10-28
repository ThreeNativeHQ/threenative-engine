import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const mcpDir = path.resolve(fileURLToPath(import.meta.url), "..", "..", "mcp");

// A stdio server that answers initialize, lists one tool and echoes the call with its cwd and env.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") reply(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  if (method === "tools/list") reply(id, { tools: [{ name: "echo", description: "Echoes.\\nSecond line." }] });
  if (method === "tools/call") reply(id, { content: [{ type: "text", text: JSON.stringify({ args: params.arguments, cwd: process.cwd(), dir: process.env.FAKE_DIR }) }] });
});
`;

/** A game as pnpm leaves it: `.mcp.json` at the root, the bridge under core in node_modules. */
function game(servers: Record<string, unknown>): { call: string; root: string } {
  const root = makeTempDirSync("tn-mcp-call-");
  const coreMcp = path.join(root, "node_modules", "@threenative", "core", "mcp");
  mkdirSync(coreMcp, { recursive: true });
  copyFileSync(path.join(mcpDir, "call.mjs"), path.join(coreMcp, "call.mjs"));
  writeFileSync(path.join(root, "fake-server.mjs"), FAKE_SERVER);
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  return { call: path.join(coreMcp, "call.mjs"), root };
}

// The caller sits outside the game, like a session that scaffolded it.
const run = (call: string, ...args: string[]) =>
  spawnSync(process.execPath, [call, ...args], {
    cwd: path.dirname(path.dirname(call)),
    encoding: "utf8",
    timeout: 60_000,
  });

describe("mcp/call.mjs", () => {
  const fake = {
    args: ["./fake-server.mjs"],
    command: "node",
    env: { FAKE_DIR: "./public/assets" },
  };

  it("lists the servers, a server's tools and calls one the way a host starts it", () => {
    const { call, root } = game({ "threenative-fake": fake });
    expect(run(call).stdout).toBe("threenative-fake\n");
    expect(run(call, "threenative-fake").stdout).toBe("echo: Echoes.\n");
    const called = run(call, "threenative-fake", "echo", '{"word":"jump"}');
    expect(called.status).toBe(0);
    expect(JSON.parse(called.stdout)).toEqual({
      args: { word: "jump" },
      cwd: root,
      dir: "./public/assets",
    });
  });

  it("names the servers the project has when asked for another", () => {
    const { call } = game({ "threenative-fake": fake });
    const unknown = run(call, "threenative-nope");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("TN_MCP_CALL_UNKNOWN_SERVER: threenative-nope;");
    expect(unknown.stderr).toContain("has threenative-fake");
  });

  it("reaches the real engine server's reference and capability tools", () => {
    const engine = { args: [path.join(mcpDir, "engine.mjs")], command: "node" };
    const { call } = game({ "threenative-engine": engine });
    const tools = run(call, "threenative-engine").stdout;
    expect(tools).toContain("engine_search_capabilities:");
    expect(tools).toContain("engine_search_references:");
    const hits = run(
      call,
      "threenative-engine",
      "engine_search_capabilities",
      '{"situation":"jump"}',
    );
    expect(hits.status).toBe(0);
    expect(JSON.parse(hits.stdout).results.length).toBeGreaterThan(0);
  });
});
