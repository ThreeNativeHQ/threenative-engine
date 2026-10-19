import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { handleLine } from "../src/index.js";

const manifestFile = path.resolve("packages/create-threenative/capabilities.json");

function frame(id: unknown, method: string, params?: unknown): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

describe("threenative-engine-mcp stdio contract", () => {
  // Every tools/call below would otherwise append to the launch directory's real log.
  beforeEach(() => {
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
  });
  afterEach(() => {
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
  });

  it("answers initialize with the pinned protocol version and server info", () => {
    const response = JSON.parse(handleLine(frame(1, "initialize", {}), manifestFile) ?? "");
    expect(response).toEqual({
      id: 1,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: { listChanged: false } },
        instructions:
          'Before authoring, infer concrete gameplay mechanics. Preserve the request\'s distinctive fantasy: choose the smallest loop that uses its characteristic setting, traversal medium, or simulation instead of a generic character game with themed props, and search those implied mechanics even when the user did not name engine terms. Search the mechanically explicit complete request with scope "request", then each mechanic with scope "mechanic". A genre label alone is not a capability query: clarify or decompose it; do not assume a preset. Inspect capability detail and obey constraints before implementing. Capability detail is authoritative on platform support: never invent a platform limitation it does not state. A response with verdict "none" is an actionable answer: follow its guidance and write game-owned behavior in src/ instead of rephrasing the same request.',
        protocolVersion: "2025-06-18",
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.5" },
      },
    });
  });

  it("lists the two capability tools in order", () => {
    const response = JSON.parse(handleLine(frame(1, "tools/list"), manifestFile) ?? "");
    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "engine_search_capabilities",
      "engine_capability_detail",
    ]);
    expect(response.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
        }),
      ]),
    );
  });

  it("answers tools/call for a search with the results as text content", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", {
          arguments: { situation: "put a weapon in a character's hand" },
          name: "engine_search_capabilities",
        }),
        manifestFile,
      ) ?? "",
    );
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({
      guidance: "",
      results: expect.arrayContaining([expect.objectContaining({ symbol: "attachToBone" })]),
      verdict: "matched",
    });
  });

  it("answers tools/call for a detail lookup", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", {
          arguments: { symbol: "GroundSnap" },
          name: "engine_capability_detail",
        }),
        manifestFile,
      ) ?? "",
    );
    expect(JSON.parse(response.result.content[0].text).symbol).toBe("GroundSnap");
  });

  it("answers a detail lookup for a shared symbol with every match in one call", () => {
    const detail = (argumentsValue: Record<string, string>): Record<string, unknown> => {
      const response = JSON.parse(
        handleLine(
          frame(1, "tools/call", { arguments: argumentsValue, name: "engine_capability_detail" }),
          manifestFile,
        ) ?? "",
      );
      expect(response.result.isError).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    };

    const shared = detail({ symbol: "createThreeObject" }) as {
      matches: { importPath: string }[];
    };
    expect(shared.matches.map((match) => match.importPath)).toEqual([
      "@threenative/raw-unreal",
      "@threenative/ueformat",
    ]);
    expect(
      detail({ importPath: "@threenative/ueformat", symbol: "createThreeObject" }).importPath,
    ).toBe("@threenative/ueformat");
  });

  it("answers a malformed JSON line with a -32700 parse error addressed to id null", () => {
    const response = JSON.parse(handleLine("not json", manifestFile) ?? "");
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
    expect(response.error.message).toContain("Invalid JSON");
  });

  it("answers an unknown method with -32601", () => {
    const response = JSON.parse(handleLine(frame(1, "resources/list"), manifestFile) ?? "");
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toBe("Method not found: resources/list");
  });

  it("answers a non-object tools/call params with -32000", () => {
    const response = JSON.parse(handleLine(frame(1, "tools/call", "nope"), manifestFile) ?? "");
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("tools/call requires an object params value");
  });

  it("answers an unknown tool name with -32000 naming it", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", { arguments: { situation: "zoom" }, name: "engine_explode" }),
        manifestFile,
      ) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("Unknown engine MCP tool 'engine_explode'.");
  });

  it("answers a tool call with missing arguments as a -32000 tool error", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", { arguments: {}, name: "engine_search_capabilities" }),
        manifestFile,
      ) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("situation");
  });

  it("consumes silently: blank lines, notifications without an id, and non-record lines", () => {
    expect(handleLine("", manifestFile)).toBeUndefined();
    expect(handleLine("   \t ", manifestFile)).toBeUndefined();
    expect(
      handleLine(JSON.stringify({ jsonrpc: "2.0", method: "ping" }), manifestFile),
    ).toBeUndefined();
    expect(handleLine(JSON.stringify([]), manifestFile)).toBeUndefined();
  });

  it("answers tools/call whose arguments are missing the required key with -32000", () => {
    const noArguments = JSON.parse(
      handleLine(frame(1, "tools/call", { name: "engine_search_capabilities" }), manifestFile) ??
        "",
    );
    expect(noArguments.error.code).toBe(-32000);
    expect(noArguments.error.message).toContain("requires a string 'situation' argument");
  });

  it("errors a numeric situation argument instead of searching with its string form", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", { arguments: { situation: 0 }, name: "engine_search_capabilities" }),
        manifestFile,
      ) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("situation");
  });

  it("refuses a null scope instead of quietly searching as mechanic", () => {
    const response = JSON.parse(
      handleLine(
        frame(1, "tools/call", {
          arguments: { scope: null, situation: "spawn many identical props" },
          name: "engine_search_capabilities",
        }),
        manifestFile,
      ) ?? "",
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
  ])("refuses %s called with %j as a named -32000 tool error", (name, arguments_, message) => {
    const response = JSON.parse(
      handleLine(frame(1, "tools/call", { arguments: arguments_, name }), manifestFile) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe(message);
  });

  it("refuses a manifest whose notOwned ids repeat, naming the duplicate", () => {
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
      handleLine(
        frame(1, "tools/call", {
          arguments: { situation: "spawn props" },
          name: "engine_search_capabilities",
        }),
        file,
      ) ?? "",
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("notOwned contains duplicate id 'dup'");
  });

  it("appends one JSON line per tool call, rejections included", () => {
    const logFile = path.join(makeTempDirSync("threenative-engine-mcp-log-"), "calls.log");
    process.env.THREENATIVE_ENGINE_MCP_LOG = logFile;
    handleLine(
      frame(1, "tools/call", {
        arguments: { situation: "spawn many identical props" },
        name: "engine_search_capabilities",
      }),
      manifestFile,
    );
    handleLine(
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

  it("writes nothing when the log is off", () => {
    const logFile = path.join(makeTempDirSync("threenative-engine-mcp-log-"), "calls.log");
    process.env.THREENATIVE_ENGINE_MCP_LOG = "off";
    handleLine(
      frame(1, "tools/call", {
        arguments: { situation: "spawn many identical props" },
        name: "engine_search_capabilities",
      }),
      manifestFile,
    );
    expect(() => readFileSync(logFile, "utf8")).toThrow();
  });
});
