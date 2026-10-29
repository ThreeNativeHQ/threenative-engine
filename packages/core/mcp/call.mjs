#!/usr/bin/env node
// Lists or calls the tools of one ThreeNative MCP server without an MCP host.
//   node <game>/node_modules/@threenative/core/mcp/call.mjs                  servers
//   node <game>/node_modules/@threenative/core/mcp/call.mjs <server>         its tools
//   node <game>/node_modules/@threenative/core/mcp/call.mjs <server> <tool> '<json>'
// A host loads a project's `.mcp.json` only when a session starts in that folder, so an agent that
// scaffolded the game mid-session has none of its servers (PRD-750: five cold builds, zero engine
// calls). This starts the server exactly as the host would — the same command, args, env and cwd
// from that `.mcp.json` — and speaks the stdio protocol for one request.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

function projectRoot() {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, ".mcp.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(
        "TN_MCP_CALL_NO_PROJECT: no .mcp.json above this package; run pnpm install in the game.",
      );
    directory = parent;
  }
  return directory;
}

function request(server, root, method, params) {
  const child = spawn(server.command, server.args ?? [], {
    cwd: root,
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return new Promise((resolve, reject) => {
    // Asset downloads and Blender conversions are slow; a hung server still ends the call.
    const timer = setTimeout(
      () => reject(new Error(`TN_MCP_CALL_TIMEOUT: ${method} took over 300 s`)),
      300_000,
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(
        new Error(`TN_MCP_CALL_EXIT: the server exited (${code}) before it answered ${method}`),
      ),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Some servers log to stdout before they speak the protocol.
      if (!line.trim().startsWith("{")) return;
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method, params });
      } else if (message.id === 2) {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "threenative-call", version: "1" },
      },
    });
  }).finally(() => child.kill());
}

const [name, tool, args] = process.argv.slice(2);
const root = projectRoot();
const servers = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers ?? {};
if (name === undefined) {
  process.stdout.write(`${Object.keys(servers).join("\n")}\n`);
} else if (servers[name] === undefined) {
  process.stderr.write(
    `TN_MCP_CALL_UNKNOWN_SERVER: ${name}; ${root}/.mcp.json has ${Object.keys(servers).join(", ")}\n`,
  );
  process.exitCode = 2;
} else {
  try {
    if (tool === undefined) {
      const { tools } = await request(servers[name], root, "tools/list", {});
      for (const { name: toolName, description = "" } of tools)
        process.stdout.write(`${toolName}: ${description.split("\n")[0]}\n`);
    } else {
      const result = await request(servers[name], root, "tools/call", {
        name: tool,
        arguments: JSON.parse(args ?? "{}"),
      });
      const text = (result.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text);
      process.stdout.write(`${text.length > 0 ? text.join("\n") : JSON.stringify(result)}\n`);
      if (result.isError) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
