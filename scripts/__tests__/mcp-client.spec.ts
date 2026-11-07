// The client's four rules are the ones the hand-rolled copies got right only by accident: a reply
// resolves its own request, a server that exits rejects everything pending, a late server fails the
// request instead of hanging, and the failure carries the server's stderr. The spec runs real fake
// servers, so a partial line and a dead child are exercised rather than simulated.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { McpError, startMcpServer } from "../lib/mcp-client.js";

/** Writes a server script and returns it with its arguments. */
function server(lines: readonly string[]): { args: string[]; command: string } {
  const root = makeTempDirSync("tn-mcp-");
  const file = path.join(root, "server.mjs");
  mkdirSync(root, { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return { args: [file], command: process.execPath };
}

describe("the MCP client", () => {
  it("should resolve each request with its own result", async () => {
    const script = server([
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  for (const line of buffer.split('\\n').slice(0, -1)) {",
      "    const request = JSON.parse(line);",
      "    if (request.id === undefined) continue;",
      "    process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: '2.0', result: { echo: request.method } }) + '\\n');",
      "  }",
      "  buffer = buffer.split('\\n').at(-1);",
      "});",
      "setTimeout(() => {}, 5_000);",
    ]);
    const client = startMcpServer({ ...script, label: "echo server", timeoutMs: 3_000 });
    try {
      expect(await client.request("initialize")).toEqual({ echo: "initialize" });
      expect(await client.request("tools/list")).toEqual({ echo: "tools/list" });
      expect(client.alive()).toBe(true);
    } finally {
      client.close();
    }
  });

  it("should reject a pending request when the server exits, naming its stderr", async () => {
    const script = server([
      "process.stdin.once('data', () => {",
      "  process.stderr.write('boom: no database');",
      "  process.exit(7);",
      "});",
    ]);
    const client = startMcpServer({ ...script, label: "dying server", timeoutMs: 3_000 });
    try {
      const error = await client.request("tools/list").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("TN_MCP_EXITED");
      expect((error as Error).message).toContain("dying server exited (code 7)");
      expect((error as Error).message).toContain("boom: no database");
    } finally {
      client.close();
    }
  });

  it("should refuse a request once the server is gone rather than waiting for the deadline", async () => {
    const script = server(["process.exit(0);"]);
    const client = startMcpServer({ ...script, label: "gone server", timeoutMs: 5_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.alive()).toBe(false);
      // Either refusal is right here: the request is not sent to a dead server, and the message
      // names it rather than waiting out the deadline.
      await expect(client.request("tools/list")).rejects.toThrow(
        /gone server (exited|is not running)/u,
      );
    } finally {
      client.close();
    }
  });

  it("should time out a server that answers nothing, and name the deadline", async () => {
    const script = server(["setTimeout(() => {}, 5_000);"]);
    const client = startMcpServer({ ...script, label: "silent server", timeoutMs: 80 });
    try {
      await expect(client.request("tools/call")).rejects.toThrow(
        /TN_MCP_TIMEOUT: silent server tools\/call timed out after 80ms/u,
      );
    } finally {
      client.close();
    }
  });

  it("should refuse a request when the server closes its input", async () => {
    // A server that stops reading leaves the next write facing a closed pipe. The server is ESM, so
    // it imports `closeSync` — a `require` here would be a swallowed ReferenceError and fd 0 would
    // stay open, which is exactly how a weaker version of this spec used to pass either way.
    const script = server([
      'import { closeSync } from "node:fs";',
      "closeSync(0);",
      "process.stderr.write('input closed\\n');",
      "setInterval(() => {}, 1_000);",
    ]);
    const client = startMcpServer({ ...script, label: "closing server", timeoutMs: 5_000 });
    try {
      // Poll rather than sleep: a loaded runner starts Node slowly, and a fixed wait would be a
      // flaky red that cannot pass falsely either way.
      const deadline = Date.now() + 10_000;
      while (!client.stderr().includes("input closed") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(client.stderr()).toContain("input closed");
      const error = await client.request("tools/list").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpError);
      expect((error as Error).message).toMatch(/TN_MCP_EXITED: closing server closed its input/u);
    } finally {
      client.close();
    }
  });

  it("should refuse a reply that is not JSON-RPC 2.0, or that carries no result object", async () => {
    for (const line of [
      { id: 1, result: {} },
      { id: 1, jsonrpc: "1.0", result: {} },
      { id: 1, jsonrpc: "2.0" },
      { id: 1, jsonrpc: "2.0", result: [] },
    ]) {
      const script = server([
        "process.stdin.once('data', (chunk) => {",
        `  process.stdout.write(${JSON.stringify(`${JSON.stringify(line)}\n`)});`,
        "});",
        "setTimeout(() => {}, 5_000);",
      ]);
      const client = startMcpServer({ ...script, label: "sloppy server", timeoutMs: 3_000 });
      try {
        await expect(client.request("tools/list"), JSON.stringify(line)).rejects.toThrow(
          /TN_MCP_REPLY: sloppy server tools\/list/u,
        );
      } finally {
        client.close();
      }
    }
  });

  it("should surface a JSON-RPC error as a refusal naming the method", async () => {
    const script = server([
      "process.stdin.once('data', (chunk) => {",
      "  const request = JSON.parse(String(chunk));",
      "  process.stdout.write(JSON.stringify({ error: { code: -32601, message: 'no such method' }, id: request.id, jsonrpc: '2.0' }) + '\\n');",
      "});",
      "setTimeout(() => {}, 5_000);",
    ]);
    const client = startMcpServer({ ...script, label: "grumpy server", timeoutMs: 3_000 });
    try {
      await expect(client.request("tools/call")).rejects.toThrow(
        /TN_MCP_REPLY: grumpy server tools\/call: no such method/u,
      );
    } finally {
      client.close();
    }
  });
});
