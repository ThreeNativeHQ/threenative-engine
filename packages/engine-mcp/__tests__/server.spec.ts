import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { handleLine } from "../src/index.js";

const manifestFile = path.resolve("packages/create-threenative/capabilities.json");

function frame(id: unknown, method: string, params?: unknown): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

describe("threenative-engine-mcp stdio contract", async () => {
  // Every tools/call below would otherwise append to the launch directory's real log.
  beforeEach(async () => {
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
  });
  afterEach(async () => {
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
  });

  it("answers initialize with the pinned protocol version and server info", async () => {
    const response = JSON.parse((await handleLine(frame(1, "initialize", {}), manifestFile)) ?? "");
    expect(response.result.instructions).not.toContain("scope");
    expect(response.result.instructions).toContain(
      "no code, level layouts, character names or art",
    );
    expect(response).toEqual({
      id: 1,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: { listChanged: false } },
        instructions: expect.stringContaining("threenative-capabilities"),
        protocolVersion: "2025-06-18",
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.6" },
      },
    });
  });

  it("hands actual MCP clients the new-game and existing-game authoring routes", async () => {
    const response = JSON.parse((await handleLine(frame(1, "initialize", {}), manifestFile)) ?? "");
    const instructions = response.result.instructions as string;
    expect(instructions).toContain("New games: steps 1-8");
    expect(instructions).toContain("Existing games: steps 5-7 only");
    expect(instructions).toContain("existing context");
    expect(instructions).toContain("reference-image visual judge");
    expect(instructions).toContain("subagents focused on specific areas");
    expect(instructions).toContain("coordinator integration before step 7");
    expect(instructions).not.toContain("Before planning or writing game source");
  });

  it("lists capability and reference tools in order", async () => {
    const response = JSON.parse((await handleLine(frame(1, "tools/list"), manifestFile)) ?? "");
    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "engine_search_capabilities",
      "engine_capability_detail",
      "engine_search_references",
      "engine_reference_detail",
      "engine_save_reference",
    ]);
    expect(response.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
        }),
      ]),
    );
  });

  it("answers tools/call for a search with the results as text content", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", {
          arguments: { situation: "put a weapon in a character's hand" },
          name: "engine_search_capabilities",
        }),
        manifestFile,
      )) ?? "",
    );
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({
      guidance: "",
      results: expect.arrayContaining([expect.objectContaining({ symbol: "attachToBone" })]),
      verdict: "matched",
    });
  });

  it("answers tools/call for a detail lookup", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", {
          arguments: { symbol: "GroundSnap" },
          name: "engine_capability_detail",
        }),
        manifestFile,
      )) ?? "",
    );
    expect(JSON.parse(response.result.content[0].text).symbol).toBe("GroundSnap");
  });

  it("answers a detail lookup for a shared symbol with every match in one call", async () => {
    const detail = async (
      argumentsValue: Record<string, string>,
    ): Promise<Record<string, unknown>> => {
      const response = JSON.parse(
        (await handleLine(
          frame(1, "tools/call", { arguments: argumentsValue, name: "engine_capability_detail" }),
          manifestFile,
        )) ?? "",
      );
      expect(response.result.isError).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    };

    const shared = (await detail({ symbol: "createThreeObject" })) as {
      matches: { importPath: string }[];
    };
    expect(shared.matches.map((match) => match.importPath)).toEqual([
      "@threenative/raw-unreal",
      "@threenative/ueformat",
    ]);
    expect(
      (await detail({ importPath: "@threenative/ueformat", symbol: "createThreeObject" }))
        .importPath,
    ).toBe("@threenative/ueformat");
  });

  it("answers a malformed JSON line with a -32700 parse error addressed to id null", async () => {
    const response = JSON.parse((await handleLine("not json", manifestFile)) ?? "");
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
    expect(response.error.message).toContain("Invalid JSON");
  });

  it("answers an unknown method with -32601", async () => {
    const response = JSON.parse((await handleLine(frame(1, "resources/list"), manifestFile)) ?? "");
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toBe("Method not found: resources/list");
  });

  it("answers a non-object tools/call params with -32000", async () => {
    const response = JSON.parse(
      (await handleLine(frame(1, "tools/call", "nope"), manifestFile)) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("tools/call requires an object params value");
  });

  it("answers an unknown tool name with -32000 naming it", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", { arguments: { situation: "zoom" }, name: "engine_explode" }),
        manifestFile,
      )) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("Unknown engine MCP tool 'engine_explode'.");
  });

  it("answers a tool call with missing arguments as a -32000 tool error", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", { arguments: {}, name: "engine_search_capabilities" }),
        manifestFile,
      )) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("situation");
  });

  it("consumes silently: blank lines, notifications without an id, and non-record lines", async () => {
    expect(await handleLine("", manifestFile)).toBeUndefined();
    expect(await handleLine("   \t ", manifestFile)).toBeUndefined();
    expect(
      await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "ping" }), manifestFile),
    ).toBeUndefined();
    expect(await handleLine(JSON.stringify([]), manifestFile)).toBeUndefined();
  });

  it("answers tools/call whose arguments are missing the required key with -32000", async () => {
    const noArguments = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", { name: "engine_search_capabilities" }),
        manifestFile,
      )) ?? "",
    );
    expect(noArguments.error.code).toBe(-32000);
    expect(noArguments.error.message).toContain("requires a string 'situation' argument");
  });

  it("errors a numeric situation argument instead of searching with its string form", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", { arguments: { situation: 0 }, name: "engine_search_capabilities" }),
        manifestFile,
      )) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("situation");
  });

  it("refuses a null scope instead of quietly searching as mechanic", async () => {
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", {
          arguments: { scope: null, situation: "spawn many identical props" },
          name: "engine_search_capabilities",
        }),
        manifestFile,
      )) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe(
      "engine_search_capabilities scope must be 'request' or 'mechanic'.",
    );
  });

  it.each([
    [
      "engine_search_capabilities",
      { scope: "deep", situation: "x" },
      "engine_search_capabilities scope must be 'request' or 'mechanic'.",
    ],
    [
      "engine_search_capabilities",
      { scope: 1, situation: "x" },
      "engine_search_capabilities scope must be 'request' or 'mechanic'.",
    ],
    [
      "engine_capability_detail",
      { symbol: 5 },
      "engine_capability_detail requires a string 'symbol' argument.",
    ],
    [
      "engine_capability_detail",
      { importPath: 5, symbol: "Foo" },
      "engine_capability_detail 'importPath' must be a string when given.",
    ],
    [
      "engine_capability_detail",
      { importPath: null, symbol: "Foo" },
      "engine_capability_detail 'importPath' must be a string when given.",
    ],
  ])(
    "refuses %s called with %j as a named -32000 tool error",
    async (name, arguments_, message) => {
      const response = JSON.parse(
        (await handleLine(frame(1, "tools/call", { arguments: arguments_, name }), manifestFile)) ??
          "",
      );
      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toBe(message);
    },
  );

  it("refuses a manifest whose notOwned ids repeat, naming the duplicate", async () => {
    const file = path.join(
      makeTempDirSync("threenative-engine-mcp-manifest-"),
      "capabilities.json",
    );
    const situation = { guidance: "Write it in src/.", id: "dup", situations: ["spawn props"] };
    writeFileSync(
      file,
      JSON.stringify({ entries: [], notOwned: [situation, situation], version: 2 }),
    );
    const response = JSON.parse(
      (await handleLine(
        frame(1, "tools/call", {
          arguments: { situation: "spawn props" },
          name: "engine_search_capabilities",
        }),
        file,
      )) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("notOwned contains duplicate id 'dup'");
  });

  it("appends one JSON line per tool call, rejections included", async () => {
    const logFile = path.join(makeTempDirSync("threenative-engine-mcp-log-"), "calls.log");
    process.env.THREENATIVE_ENGINE_MCP_LOG = logFile;
    await handleLine(
      frame(1, "tools/call", {
        arguments: { situation: "spawn many identical props" },
        name: "engine_search_capabilities",
      }),
      manifestFile,
    );
    await handleLine(
      frame(2, "tools/call", {
        arguments: { symbol: "nope" },
        name: "engine_capability_detail",
      }),
      manifestFile,
    );
    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      situation: "spawn many identical props",
      tool: "engine_search_capabilities",
      verdict: "matched",
    });
    expect(Array.isArray(lines[0]?.results)).toBe(true);
    expect(String(lines[1]?.error)).toContain("nope");
  });

  it("writes nothing when the log is off", async () => {
    const logFile = path.join(makeTempDirSync("threenative-engine-mcp-log-"), "calls.log");
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
    await handleLine(
      frame(1, "tools/call", {
        arguments: { situation: "spawn many identical props" },
        name: "engine_search_capabilities",
      }),
      manifestFile,
    );
    expect(() => readFileSync(logFile, "utf8")).toThrow();
  });
});
