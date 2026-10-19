import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "vitest";

import { listTools, request } from "../capture-asset-mcp-tools.js";

const recommended = [
  "ambientcg_list_files",
  "ambientcg_search_assets",
  "asset_download_file",
  "asset_search_sources",
  "audio_download_asset",
  "audio_search_assets",
  "polyhaven_list_files",
  "polyhaven_search_assets",
  "asset_inspect_rig",
  "asset_auto_rig",
  "asset_retarget_animations",
  "asset_preview_animation",
];

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
  const lines = createInterface({ input: stdout });
  const originalCloseListeners = new Set(lines.listeners("close"));
  return {
    child,
    lines,
    next: { value: 1 },
    reply: (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`),
    assertClean() {
      assert.equal(lines.listenerCount("line"), 0);
      assert.ok(lines.listeners("close").every((listener) => originalCloseListeners.has(listener)));
      assert.equal(child.listenerCount("error"), 0);
      assert.equal(child.listenerCount("exit"), 0);
      assert.equal(stdin.listenerCount("error"), 0);
    },
    close() {
      lines.close();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe("published asset MCP capture", () => {
  for (const [name, response, pattern] of [
    [
      "JSON-RPC error",
      { error: { code: -32601, message: "method unavailable" } },
      /method unavailable/,
    ],
    ["array result", { result: [] }, /invalid result/],
    ["missing result", {}, /invalid result/],
    ["wrong protocol", { jsonrpc: "1.0", result: {} }, /invalid JSON-RPC/],
  ] as const) {
    it(`rejects ${name} and releases request listeners`, async () => {
      const f = fixture();
      try {
        const pending = request(f.child, f.lines, f.next, "tools/list");
        f.reply({ jsonrpc: "2.0", id: 1, ...response });
        await assert.rejects(pending, pattern);
        f.assertClean();
      } finally {
        f.close();
      }
    });
  }

  it("ignores nonresponses without losing a later matching response", async () => {
    const f = fixture();
    try {
      const pending = request(f.child, f.lines, f.next, "initialize");
      for (const value of [null, [], 42, { id: 99, result: {} }, { method: "notification" }])
        f.reply(value);
      f.reply({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      assert.deepEqual(await pending, { capabilities: {} });
      f.assertClean();
    } finally {
      f.close();
    }
  });

  it("releases listeners after a timeout", async () => {
    const f = fixture();
    try {
      await assert.rejects(request(f.child, f.lines, f.next, "initialize", {}, 10), /timed out/);
      f.assertClean();
    } finally {
      f.close();
    }
  });

  for (const event of ["exit", "error", "stdin-error", "close"] as const) {
    it(`rejects immediately on ${event}`, async () => {
      const f = fixture();
      try {
        const pending = request(f.child, f.lines, f.next, "initialize");
        if (event === "stdin-error") f.child.stdin.emit("error", new Error("broken pipe"));
        else if (event === "close") f.lines.close();
        else if (event === "error") f.child.emit(event, new Error("spawn failed"));
        else f.child.emit(event, 1, null);
        await assert.rejects(pending, /exited|closed|broken pipe|spawn failed/);
        f.assertClean();
      } finally {
        f.close();
      }
    });
  }

  it("captures every page, validates the recommended surface, and sorts names", async () => {
    const f = fixture();
    const params: unknown[] = [];
    f.child.stdin.on("data", (data: Buffer) => {
      const sent = JSON.parse(data.toString());
      params.push(sent.params);
      const result =
        sent.params.cursor === undefined
          ? { tools: recommended.slice(0, 6).map((name) => ({ name })), nextCursor: "page-2" }
          : { tools: recommended.slice(6).map((name) => ({ name })) };
      f.reply({ jsonrpc: "2.0", id: sent.id, result });
    });
    try {
      const captured = await listTools(f.child, f.lines, f.next, recommended);
      assert.deepEqual(captured.map((tool) => tool.name).sort(), [...recommended].sort());
      // The snapshot's arguments come from this same response, so a tool with no schema here would
      // publish a tool page that cannot say what the tool takes.
      assert.ok(captured.every((tool) => tool.name.length > 0));
      assert.deepEqual(params, [{}, { cursor: "page-2" }]);
      f.assertClean();
    } finally {
      f.close();
    }
  });

  for (const [name, result, pattern] of [
    ["empty surface", { tools: [] }, /missing recommended/],
    ["invalid tools", { tools: null }, /invalid tools array/],
    ["invalid name", { tools: [{ name: 42 }] }, /invalid or duplicate/],
    [
      "duplicate name",
      { tools: [{ name: "asset_inspect_rig" }, { name: "asset_inspect_rig" }] },
      /invalid or duplicate/,
    ],
    ["cursor loop", { tools: [], nextCursor: "repeat" }, /repeated pagination/],
  ] as const) {
    it(`refuses a snapshot from ${name}`, async () => {
      const f = fixture();
      f.child.stdin.on("data", (data: Buffer) => {
        const sent = JSON.parse(data.toString());
        f.reply({ jsonrpc: "2.0", id: sent.id, result });
      });
      try {
        await assert.rejects(listTools(f.child, f.lines, f.next, recommended), pattern);
        f.assertClean();
      } finally {
        f.close();
      }
    });
  }

  it("handles an asynchronous write failure without an uncaught stream error", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("broken transport"));
      },
    });
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    const lines = createInterface({ input: stdout });
    try {
      await assert.rejects(request(child, lines, { value: 1 }, "initialize"), /broken transport/);
      assert.equal(lines.listenerCount("line"), 0);
    } finally {
      lines.close();
      stdout.destroy();
      stdin.destroy();
    }
  });

  it("drives a real child over newline-delimited stdio", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const lines = require('node:readline').createInterface({input:process.stdin});
      lines.on('line', line => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{method:message.method}})+'\\n');
      });
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: child.stdout });
    try {
      assert.deepEqual(await request(child, lines, { value: 1 }, "initialize", {}, 2_000), {
        method: "initialize",
      });
    } finally {
      child.kill();
      lines.close();
    }
  });
});
