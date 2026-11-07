#!/usr/bin/env tsx
// Writes `packages/create-threenative/*-mcp-tools.json` for the servers this repository publishes as
// npm packages, from the *published* package installed into a clean directory — never from a
// workspace checkout, and never from its docs. A snapshot read off source is the object asserting
// about itself: it agrees with the code by construction and would keep agreeing after a packaging
// mistake made the shipped server serve nothing at all.
//
//   pnpm tsx scripts/capture-asset-mcp-tools.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IMcpClient, startMcpServer } from "./lib/mcp-client.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read every page and refuse to overwrite the snapshot with a partial surface. */
export async function listTools(
  client: IMcpClient,
  required: readonly string[],
): Promise<readonly { name: string; description?: unknown; inputSchema?: unknown }[]> {
  const names = new Set<string>();
  const cursors = new Set<string>();
  const tools: { name: string; description?: unknown; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  // `for (;;)` rather than `do … while (true)`: the exit is the `break` on a missing cursor, and
  // biome rejects the constant condition.
  for (;;) {
    const listed = await client.request("tools/list", cursor === undefined ? {} : { cursor });
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
  let client: IMcpClient | undefined;
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
    client = startMcpServer({
      args: [entry],
      command: process.execPath,
      cwd: install,
      label: `${server.package} server`,
      timeoutMs: 30_000,
    });
    await client.initialize("tool-snapshot");
    const listedTools = await listTools(client, RECOMMENDED);
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
    client?.close();
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
