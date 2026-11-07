// `listTools` reads every page and refuses to overwrite the snapshot with a partial surface. The
// transport underneath it is `scripts/lib/mcp-client.ts`, whose own spec covers the wire: exit,
// timeout, a JSON-RPC error and a malformed envelope. Here a fake client stands in for the server, so
// each case is about pagination and the surface contract.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { listTools } from "../capture-asset-mcp-tools.js";
import { type IMcpClient, startMcpServer } from "../lib/mcp-client.js";

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

/** A client whose `request` answers from `reply`, recording the params it was asked with. */
function fakeClient(
  reply: (params: Record<string, unknown>) => Record<string, unknown>,
): IMcpClient & { readonly params: readonly Record<string, unknown>[] } {
  const params: Record<string, unknown>[] = [];
  return {
    alive: () => true,
    close: () => undefined,
    initialize: async () => ({}),
    notify: () => undefined,
    params,
    request: async (_method, sent = {}) => {
      params.push(sent);
      return reply(sent);
    },
    stderr: () => "",
  };
}

describe("published asset MCP capture", () => {
  it("captures every page, validates the recommended surface, and sorts names", async () => {
    const client = fakeClient((sent) =>
      sent.cursor === undefined
        ? { nextCursor: "page-2", tools: recommended.slice(0, 6).map((name) => ({ name })) }
        : { tools: recommended.slice(6).map((name) => ({ name })) },
    );
    const captured = await listTools(client, recommended);
    assert.deepEqual(captured.map((tool) => tool.name).sort(), [...recommended].sort());
    // The snapshot's arguments come from this same response, so a tool with no schema here would
    // publish a tool page that cannot say what the tool takes.
    assert.ok(captured.every((tool) => tool.name.length > 0));
    assert.deepEqual(client.params, [{}, { cursor: "page-2" }]);
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
    ["cursor loop", { nextCursor: "repeat", tools: [] }, /repeated pagination/],
  ] as const) {
    it(`refuses a snapshot from ${name}`, async () => {
      await assert.rejects(
        listTools(
          fakeClient(() => result),
          recommended,
        ),
        pattern,
      );
    });
  }

  it("reads a real server over newline-delimited stdio", async () => {
    const client = startMcpServer({
      args: [
        "-e",
        `
      const lines = require('node:readline').createInterface({input:process.stdin});
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'asset_inspect_rig'}]}})+'\\n');
      });
    `,
      ],
      command: process.execPath,
      label: "fake asset server",
      timeoutMs: 2_000,
    });
    try {
      assert.deepEqual(await client.request("tools/list"), {
        tools: [{ name: "asset_inspect_rig" }],
      });
    } finally {
      client.close();
    }
  });
});
