#!/usr/bin/env tsx
// Writes `packages/create-threenative/*-mcp-tools.json` for the servers this repository publishes as
// npm packages, from the *published* package installed into a clean directory — never from a
// workspace checkout, and never from its docs. A snapshot read off source is the object asserting
// about itself: it agrees with the code by construction and would keep agreeing after a packaging
// mistake made the shipped server serve nothing at all.
//
//   pnpm tsx scripts/capture-asset-mcp-tools.ts
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const REPO = path.resolve(import.meta.dirname, "..");
const SNAPSHOT_DIR = path.join(REPO, "packages/create-threenative");

/** One published server this repository pins and documents. */
interface PublishedServer {
  readonly package: string;
  readonly snapshot: string;
  readonly recommended: readonly string[];
  /** What the recorded surface is, and what `recommended` is and is not. */
  readonly comment: (version: string, tools: number) => string;
}

const SERVERS: readonly PublishedServer[] = [
  {
    package: "threenative-asset-mcp",
    snapshot: "asset-mcp-tools.json",
    recommended: [
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
      "fab_search_assets",
      "fab_list_owned",
      "fab_import_asset",
      "asset_import_unreal",
    ],
    comment: (version, tools) =>
      `The asset MCP surface a generated project actually gets. \`tools\` is the live tools/list response of the pinned version, recorded by installing ${"threenative-asset-mcp"}@${version} from the registry into a clean directory containing \`.threenative\` and driving it over stdio - not copied from its docs. \`inputSchemas\` and \`descriptions\` come from that same response, so the documentation cannot name an argument the server does not accept. The published ${version} serves all ${tools} tools, including the humanoid rig and Unreal import tools. \`profile\` is null because the server has no profile selector. \`recommended\` is the loop the template AGENTS.md teaches, not a claim about what the other tools can do - \`asset_search_sources\` is the authority on that. It includes the Fab loop: \`fab_search_assets\` finds a listing, \`fab_list_owned\` confirms it is in the library, and \`fab_import_asset\` (or \`asset_import_unreal\` for a local pack) converts the Unreal source to textured GLBs. Regenerate with \`pnpm tsx scripts/capture-asset-mcp-tools.ts\`.`,
  },
  {
    package: "threenative-sculpt-mcp",
    snapshot: "sculpt-mcp-tools.json",
    recommended: [
      "sculpt_plan",
      "sculpt_spec_gate",
      "sculpt_compare",
      "sculpt_pass_gate",
      "sculpt_grimoire",
    ],
    comment: (version, tools) =>
      `The sculpt MCP surface a generated project actually gets. \`tools\` is set-equal to the live tools/list response of version ${version} installed from the published npm tarball into a clean directory; that run also served 31 technique-safe grimoire resources. \`inputSchemas\` and \`descriptions\` come from that same response. \`recommended\` is the complete ordered authoring loop documented by every template. Regenerate with \`pnpm tsx scripts/capture-asset-mcp-tools.ts\`. The recorded surface serves ${tools} tools.`,
  },
] as const;

const scratch: string[] = [];

/** Fail closed: an MCP error is not an empty successful tool surface. */
export async function request(
  child: ChildProcessWithoutNullStreams,
  lines: ReturnType<typeof createInterface>,
  next: { value: number },
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const id = next.value++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      lines.off("line", onLine);
      lines.off("close", onClose);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdin.off("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error(`MCP ${method}: stdout closed before a response`));
    const onExit = (): void => fail(new Error(`MCP ${method}: server exited before a response`));
    const onLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // Ignore non-protocol diagnostic lines.
      }
      if (!isRecord(parsed) || parsed.id !== id) return;
      if (parsed.jsonrpc !== "2.0") {
        fail(new Error(`MCP ${method}: invalid JSON-RPC response`));
        return;
      }
      if (Object.hasOwn(parsed, "error")) {
        const error = parsed.error;
        const detail = isRecord(error)
          ? `${String(error.code)}: ${String(error.message)}`
          : "malformed error";
        fail(new Error(`MCP ${method}: ${detail}`));
        return;
      }
      if (!isRecord(parsed.result)) {
        fail(new Error(`MCP ${method}: invalid result in response`));
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed.result);
    };
    const timer = setTimeout(() => fail(new Error(`MCP ${method} timed out`)), timeoutMs);
    lines.on("line", onLine);
    lines.on("close", onClose);
    child.on("error", onError);
    child.on("exit", onExit);
    child.stdin.on("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
      return;
    }
    try {
      // Let the stream error listener settle asynchronous write failures.
      // A write callback runs before the error event; cleaning up there would
      // remove the listener too early and turn EPIPE into an uncaught error.
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read every page and refuse to overwrite the snapshot with a partial surface. */
export async function listTools(
  child: ChildProcessWithoutNullStreams,
  lines: ReturnType<typeof createInterface>,
  next: { value: number },
  required: readonly string[],
): Promise<readonly { name: string; description?: unknown; inputSchema?: unknown }[]> {
  const names = new Set<string>();
  const cursors = new Set<string>();
  const tools: { name: string; description?: unknown; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  // `for (;;)` rather than `do … while (true)`: the exit is the `break` on a missing cursor, and
  // biome rejects the constant condition.
  for (;;) {
    const listed = await request(
      child,
      lines,
      next,
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );
    if (!Array.isArray(listed.tools)) throw new Error("MCP tools/list: invalid tools array");
    for (const tool of listed.tools) {
      if (
        !isRecord(tool) ||
        typeof tool.name !== "string" ||
        tool.name.trim() === "" ||
        names.has(tool.name)
      ) {
        throw new Error("MCP tools/list: invalid or duplicate tool name");
      }
      names.add(tool.name);
      tools.push(tool as { name: string; description?: unknown; inputSchema?: unknown });
    }
    const nextCursor = listed.nextCursor;
    if (nextCursor === undefined) break;
    if (typeof nextCursor !== "string" || nextCursor === "" || cursors.has(nextCursor)) {
      throw new Error("MCP tools/list: invalid or repeated pagination cursor");
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  const missing = required.filter((name) => !names.has(name));
  if (missing.length)
    throw new Error(`MCP tools/list: missing recommended tools: ${missing.join(", ")}`);
  return tools;
}

function versionPin(server: PublishedServer): string {
  const manifest = JSON.parse(
    readFileSync(path.join(REPO, "packages/core/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.[server.package];
  if (!version) throw new Error(`TN_ASSET_SNAPSHOT: core does not pin ${server.package}.`);
  return version;
}

function installPublished(server: PublishedServer, version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tn-asset-install-"));
  scratch.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", private: true }));
  mkdirSync(path.join(root, ".threenative"));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", `${server.package}@${version}`], {
    cwd: root,
    stdio: "inherit",
  });
  return root;
}

async function capture(server: PublishedServer): Promise<void> {
  const PACKAGE = server.package;
  const SNAPSHOT = path.join(SNAPSHOT_DIR, server.snapshot);
  const RECOMMENDED = server.recommended;
  let child: ChildProcessWithoutNullStreams | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    const version = versionPin(server);
    const install = installPublished(server, version);
    const installed = path.join(install, "node_modules", PACKAGE);
    const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      version: string;
    };
    if (manifest.version !== version) {
      throw new Error(
        `TN_ASSET_SNAPSHOT: registry ${PACKAGE}@${version} resolved ${manifest.version}.`,
      );
    }
    const entry = path.join(installed, manifest.bin[PACKAGE] ?? "");
    child = spawn(process.execPath, [entry], { cwd: install, stdio: ["pipe", "pipe", "pipe"] });
    lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    const next = { value: 1 };
    await request(child, lines, next, "initialize", {
      capabilities: {},
      clientInfo: { name: "tool-snapshot", version: "0" },
      protocolVersion: "2025-06-18",
    });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listedTools = await listTools(child, lines, next, RECOMMENDED);
    const tools = listedTools.map((tool) => tool.name).sort();
    // The schemas come from the same live response, so no doc restates an argument by hand.
    const inputSchemas = Object.fromEntries(
      listedTools.map((tool) => [tool.name, tool.inputSchema ?? {}]),
    );
    const descriptions = Object.fromEntries(
      listedTools.map((tool) => [tool.name, tool.description ?? ""]),
    );
    const snapshot = {
      comment: server.comment(version, tools.length),
      version,
      profile: null,
      recommended: [...RECOMMENDED],
      tools,
      inputSchemas,
      descriptions,
    };
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`${PACKAGE} surface: ${tools.length} tool(s) -> ${SNAPSHOT}\n`);
  } finally {
    child?.kill();
    lines?.close();
    for (const root of scratch.splice(0)) rmSync(root, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  for (const server of SERVERS) await capture(server);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
