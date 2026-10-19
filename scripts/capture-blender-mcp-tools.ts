#!/usr/bin/env tsx
// Writes `packages/create-threenative/blender-mcp-tools.json` from a packed tarball installed into
// a clean directory — never from `packages/blender-mcp/src`. A snapshot read off the source is the
// object asserting about itself: it agrees with the code by construction and would keep agreeing
// after a packaging mistake made the shipped server serve nothing at all.
//
// The published-tarball form PRD-346 asks for is not available while the package is unpublished, so
// this packs the workspace and installs *that artifact*, which is what CI scaffolds from too.
//
//   pnpm tsx scripts/capture-blender-mcp-tools.ts
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const REPO = path.resolve(import.meta.dirname, "..");
const SNAPSHOT = path.join(REPO, "packages/create-threenative/blender-mcp-tools.json");
const PACKAGE = "threenative-blender-mcp";
const RECOMMENDED = [
  "blender_status",
  "blender_inspect",
  "blender_convert",
  "blender_recipes",
  "blender_run_python",
] as const;

/** Scratch roots this run owns, removed together in `main`'s finally. */
const scratch: string[] = [];

function packTarball(): string {
  const staging = mkdtempSync(path.join(tmpdir(), "tn-blender-pack-"));
  scratch.push(staging);
  execFileSync("pnpm", ["--filter", PACKAGE, "pack", "--pack-destination", staging], {
    cwd: REPO,
    stdio: "inherit",
  });
  const tarball = readdirSync(staging).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error(`TN_BLENDER_SNAPSHOT: pnpm pack produced no tarball in ${staging}.`);
  }
  return path.join(staging, tarball);
}

function installTarball(tarball: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tn-blender-install-"));
  scratch.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: root,
    stdio: "inherit",
  });
  return root;
}

async function request(
  child: ChildProcessWithoutNullStreams,
  lines: ReturnType<typeof createInterface>,
  next: { value: number },
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const id = next.value++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 20_000);
    const onLine = (line: string): void => {
      let parsed: { id?: unknown; result?: Record<string, unknown> };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.id !== id) return;
      clearTimeout(timer);
      lines.off("line", onLine);
      resolve(parsed.result ?? {});
    };
    lines.on("line", onLine);
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
  });
}

async function main(): Promise<void> {
  const install = installTarball(packTarball());
  const installed = path.join(install, "node_modules", PACKAGE);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    version: string;
  };
  const entry = path.join(installed, manifest.bin[PACKAGE] ?? "");
  const child = spawn(process.execPath, [entry], { cwd: install, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const next = { value: 1 };
  try {
    const initialized = await request(child, lines, next, "initialize", {
      capabilities: {},
      clientInfo: { name: "tool-snapshot", version: "0" },
      protocolVersion: "2025-06-18",
    });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await request(child, lines, next, "tools/list");
    const status = await request(child, lines, next, "tools/call", {
      arguments: {},
      name: "blender_status",
    });
    // The schemas come from the same live response, so the docs never restate an argument by hand.
    const listedTools = listed.tools as readonly {
      name: string;
      description?: unknown;
      inputSchema?: unknown;
    }[];
    const tools = listedTools.map((tool) => tool.name).sort();
    const inputSchemas = Object.fromEntries(
      listedTools.map((tool) => [tool.name, tool.inputSchema ?? {}]),
    );
    const descriptions = Object.fromEntries(
      listedTools.map((tool) => [tool.name, tool.description ?? ""]),
    );
    const statusText = (status.content as { text: string }[])[0]?.text ?? "{}";
    const snapshot = {
      comment: `The blender MCP surface a generated project actually gets. \`tools\` is set-equal to the live tools/list response of version ${manifest.version}, packed from this workspace and installed from that tarball into a clean directory — never read from src/. \`recommended\` is the ordered loop the shipped agent docs describe. Regenerate with \`pnpm tsx scripts/capture-blender-mcp-tools.ts\`.`,
      version: manifest.version,
      serverInfo: initialized.serverInfo,
      recommended: [...RECOMMENDED],
      tools,
      inputSchemas,
      descriptions,
      statusShape: Object.keys(JSON.parse(statusText) as Record<string, unknown>).sort(),
    };
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`blender MCP surface: ${tools.length} tool(s) -> ${SNAPSHOT}\n`);
  } finally {
    child.kill();
    lines.close();
    for (const root of scratch.splice(0)) rmSync(root, { force: true, recursive: true });
  }
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
