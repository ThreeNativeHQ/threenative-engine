import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { staleHostConfigs } from "../../../scripts/sync-mcp-configs.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { MCP_HOSTS } from "../../core/mcp/install.mjs";
import { MCP_SERVERS } from "../../core/mcp/servers.mjs";
import { createProject, discoverTemplateNames } from "../src/index.js";

// Read off disk, so a kit added tomorrow has its MCP wiring gated the day it ships.
const templates = discoverTemplateNames();
const engineMcp = "threenative-engine-mcp";
const enginePackageRoot = path.resolve("packages/engine-mcp");
const blenderMcp = "threenative-blender-mcp";
const blenderPackageRoot = path.resolve("packages/blender-mcp");
const corePackageRoot = path.resolve("packages/core");
const physicsPackageRoot = path.resolve("packages/physics");
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
// Every budget in this file is a hang detector, not a schedule - the rule vitest.config.ts:26
// already states for `testTimeout`. `watchMcpChild` rejects the instant a server dies, with its
// stderr attached, so every real failure is reported fast and precisely no matter how large these
// are. What is left for a wall clock to catch is a server that is alive and silent forever, and
// the only wrong answer there is a number small enough to fire on a slow machine.
//
// One budget covers every method, `initialize` included. Scoping the repair to one method name is
// what left this defect live twice: #176 raised it at three real-server probes and missed the
// liveness probes, and scoping it to `initialize` alone still left eight real-server `tools/list`
// and `tools/call` sites racing a 2 000 ms clock against machine speed - the same class of
// failure under a different method name.
const MCP_REQUEST_TIMEOUT_MS = 30_000;
// The one genuinely long call: the published creature compiler has a 60-second bounded operation
// of its own, so its budget has to clear that before it can detect a hang at all.
const MCP_COMPILE_REQUEST_TIMEOUT_MS = 90_000;

// A test's own budget must outlast every MCP budget that test can spend, or vitest kills the test
// first and the failure loses the server stderr the inner timer exists to attach. Deriving one
// from the other keeps that ordering true by construction instead of by two hand-written numbers.
const TEST_BUDGET_MARGIN = 2;
function testBudget(...spent: readonly number[]): number {
  return Math.max(...spent) * TEST_BUDGET_MARGIN;
}

// Removing scaffolded project trees is real file I/O, and 10 000 ms is vitest's default for a hook
// rather than a measurement of this one; an oversubscribed run produced four
// `Hook timed out in 10000ms`.
const CLEANUP_HOOK_TIMEOUT_MS = 120_000;

// Probes that spend an MCP budget derive their test budget from the largest one they can spend.
const MCP_PROBE_TEST_TIMEOUT_MS = testBudget(MCP_REQUEST_TIMEOUT_MS);
const COMPILE_PROBE_TEST_TIMEOUT_MS = testBudget(MCP_COMPILE_REQUEST_TIMEOUT_MS);
// These two spawn no server and call `request` never; their cost is one `createProject` per
// template, so their budget scales with the template count and not with any MCP budget.
const SCAFFOLD_ONLY_TEST_TIMEOUT_MS = Math.max(30_000, templates.length * 6_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilitySearchResponse(value: unknown): {
  guidance: string;
  results: readonly Record<string, unknown>[];
  verdict: "matched" | "none";
} {
  if (
    !isRecord(value) ||
    (value.verdict !== "matched" && value.verdict !== "none") ||
    typeof value.guidance !== "string" ||
    !Array.isArray(value.results) ||
    !value.results.every(isRecord)
  ) {
    throw new Error("engine search response was malformed");
  }
  return {
    guidance: value.guidance,
    results: value.results,
    verdict: value.verdict,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
}, CLEANUP_HOOK_TIMEOUT_MS);

async function linkEngineMcp(target: string): Promise<void> {
  const destination = path.join(target, "node_modules", engineMcp);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(enginePackageRoot, destination, "dir");
}

// The scaffold launches every MCP server through a shim inside `@threenative/core`, so the probe
// only proves anything with core present — the shim is the code that finds and starts the server.
async function linkCore(target: string): Promise<void> {
  const destination = path.join(target, "node_modules", "@threenative", "core");
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(corePackageRoot, destination, "dir");
}

async function linkBlenderMcp(target: string): Promise<void> {
  const destination = path.join(target, "node_modules", blenderMcp);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(blenderPackageRoot, destination, "dir");
}

async function linkPhysics(target: string): Promise<void> {
  const destination = path.join(target, "node_modules", "@threenative", "physics");
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(physicsPackageRoot, destination, "dir");
}

async function linkRegistryAssetMcp(target: string): Promise<void> {
  const consumer = path.join(target, "asset-mcp-consumer");
  await mkdir(consumer, { recursive: true });
  await execFileAsync(
    "pnpm",
    [
      "--dir",
      consumer,
      "add",
      "--ignore-workspace",
      "--lockfile=false",
      "threenative-asset-mcp@0.8.0",
    ],
    { cwd: path.resolve(".") },
  );
  const installed = path.join(consumer, "node_modules", "threenative-asset-mcp");
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  expect(manifest.name).toBe("threenative-asset-mcp");
  expect(manifest.version).toBe("0.8.0");
  const destination = path.join(target, "node_modules", "threenative-asset-mcp");
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(installed, destination, "dir");
}

function toolText(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null) {
    throw new Error("MCP tool response has no text content");
  }
  const text = (content[0] as Record<string, unknown>).text;
  if (typeof text !== "string") throw new Error("MCP tool response text is missing");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Why a dead server must not wait out its budget.
 *
 * The budgets above bound a server that is *slow*. A server that has *died* answers nothing, and a
 * timer alone cannot tell the two apart — so the broken shim these tests exist to catch arrives as
 * a slow, contentless `timed out`, with the stack trace that explains it discarded. Worse,
 * `stdio: "pipe"` with nothing reading stderr deadlocks the child once that pipe fills, which is a
 * hang invented by the harness rather than found by it.
 *
 * `scripts/verify-golden-path.ts:602-626` already drives this protocol this way. Kept local
 * because the two speak to different servers; if a third caller appears, extract it.
 */
interface IMcpLiveness {
  readonly pending: Set<(error: Error) => void>;
  stderr: string;
  terminal?: Error;
}

const mcpLiveness = new WeakMap<ChildProcessWithoutNullStreams, IMcpLiveness>();

function watchMcpChild(child: ChildProcessWithoutNullStreams): IMcpLiveness {
  const existing = mcpLiveness.get(child);
  if (existing !== undefined) return existing;
  const state: IMcpLiveness = { pending: new Set(), stderr: "" };
  mcpLiveness.set(child, state);
  const failPending = (error: Error): void => {
    if (state.terminal !== undefined) return;
    state.terminal = error;
    for (const reject of [...state.pending]) reject(error);
    state.pending.clear();
  };
  child.stderr.on("data", (chunk: Buffer | string) => {
    // Drain the pipe without retaining the entire lifetime of a noisy compiler.
    state.stderr = (state.stderr + chunk.toString()).slice(-4_096);
  });
  child.once("error", (error: unknown) => {
    failPending(error instanceof Error ? error : new Error(String(error)));
  });
  // A broken stdin emits on the stream, not on ChildProcess (including notifications).
  child.stdin.on("error", failPending);
  // exit can precede the last stdout/stderr data; close runs after both pipes drain.
  child.once("close", (code, signal) => {
    const detail = state.stderr.trim().slice(-500);
    failPending(
      new Error(
        `MCP server exited before answering (${code ?? `signal ${signal ?? "unknown"}`})${
          detail.length > 0 ? `: ${detail}` : ""
        }`,
      ),
    );
  });
  return state;
}

async function request(
  child: ChildProcessWithoutNullStreams,
  nextId: { value: number },
  lines: ReturnType<typeof createInterface>,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = MCP_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const id = nextId.value++;
  const liveness = watchMcpChild(child);
  if (liveness.terminal !== undefined) throw liveness.terminal;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = (error: Error): void => {
      clearTimeout(timer);
      liveness.pending.delete(fail);
      lines.off("line", onLine);
      reject(error);
    };
    const timer = setTimeout(() => {
      const detail = liveness.stderr.trim().slice(-500);
      fail(
        new Error(
          `MCP ${method} timed out after ${timeoutMs} ms${
            detail.length > 0 ? `; server stderr: ${detail}` : ""
          }`,
        ),
      );
    }, timeoutMs);
    liveness.pending.add(fail);
    const onLine = (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const record = parsed as Record<string, unknown>;
      if (record.id !== id) return;
      clearTimeout(timer);
      liveness.pending.delete(fail);
      lines.off("line", onLine);
      if (record.error !== undefined) reject(new Error(JSON.stringify(record.error)));
      else resolve((record.result ?? {}) as Record<string, unknown>);
    };
    lines.on("line", onLine);
  });
  child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
  return response;
}

describe("MCP probe liveness", () => {
  const children: Array<{
    child: ChildProcessWithoutNullStreams;
    lines: ReturnType<typeof createInterface>;
    closed: Promise<void>;
  }> = [];

  function startServer(source: string, command = process.execPath) {
    const child = spawn(command, ["-e", source], { stdio: "pipe" });
    const lines = createInterface({ input: child.stdout });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    children.push({ child, lines, closed });
    return { child, lines, closed, state: watchMcpChild(child), nextId: { value: 1 } };
  }

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(async ({ child, lines, closed }) => {
        lines.close();
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      }),
    );
  }, CLEANUP_HOOK_TIMEOUT_MS);

  it("bounds retained stderr while draining more than a pipe can buffer", async () => {
    const { child, lines, nextId, state } = startServer(`
      process.stderr.write("x".repeat(1024 * 1024) + "diagnostic-tail", () => {
        process.stdout.write(JSON.stringify({ id: 1, result: { ready: true } }) + "\\n");
      });
      setInterval(() => {}, 1000);
    `);
    assert.deepEqual(await request(child, nextId, lines, "initialize"), { ready: true });
    assert.ok(state.stderr.length <= 4_096, `retained ${state.stderr.length} characters`);
    assert.ok(state.stderr.endsWith("diagnostic-tail"));
    assert.equal(state.pending.size, 0);
    assert.equal(lines.listenerCount("line"), 0);
  });

  it("accepts a buffered final response even when the process has already exited", async () => {
    const { child, lines, nextId } = startServer(`
      process.stdout.write(JSON.stringify({ id: 1, result: { ready: true } }) + "\\n");
    `);
    // Force the valid exit-before-EOF ordering, rather than hoping to win an OS scheduling race.
    child.stdout.pause();
    assert.deepEqual(await request(child, nextId, lines, "initialize"), { ready: true });
  });

  it("includes stderr that drains after process exit in the failure", async () => {
    const { child, lines, nextId } = startServer(`
      process.stderr.write("last diagnostic");
      process.exitCode = 3;
    `);
    child.stderr.pause();
    await assert.rejects(request(child, nextId, lines, "initialize"), /\(3\): last diagnostic/);
  });

  it(
    "rejects every pending request on exit without waiting for the compile budget",
    async () => {
      const { child, lines, nextId, state, closed } = startServer("process.exitCode = 3;");
      const results = await Promise.allSettled([
        request(child, nextId, lines, "initialize", {}, MCP_COMPILE_REQUEST_TIMEOUT_MS),
        request(child, nextId, lines, "tools/list", {}, MCP_COMPILE_REQUEST_TIMEOUT_MS),
      ]);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.match(String(result.reason), /exited.*\(3\)/);
      }
      await closed;
      assert.equal(state.pending.size, 0);
      assert.equal(lines.listenerCount("line"), 0);
      await assert.rejects(request(child, nextId, lines, "tools/list"), /exited.*\(3\)/);
      // This test spends the compile budget, which is deliberately larger than vitest's own default.
      // Without its own budget it inherits `testTimeout: 60_000` (vitest.config.ts:26), so a
      // regression in the early-`close` rejection - the exact thing this test exists to catch -
      // would surface as a bare `Test timed out in 60000ms` with the server stderr discarded.
    },
    COMPILE_PROBE_TEST_TIMEOUT_MS,
  );

  it("handles stdin errors and preserves the original failure after close", async () => {
    const { child, lines, nextId, state, closed } = startServer("setInterval(() => {}, 1000);");
    child.stdin.end();
    await assert.rejects(request(child, nextId, lines, "initialize"), /write after end/);
    assert.equal(state.pending.size, 0);
    assert.equal(lines.listenerCount("line"), 0);
    child.kill("SIGKILL");
    await closed;
    await assert.rejects(request(child, nextId, lines, "tools/list"), /write after end/);
  });

  it("preserves a failed spawn error rather than replacing it with the close status", async () => {
    const root = await makeTempDir("threenative-mcp-missing-");
    temporaryRoots.push(root);
    const { child, lines, nextId, state, closed } = startServer("", path.join(root, "missing"));
    await assert.rejects(request(child, nextId, lines, "initialize"), { code: "ENOENT" });
    await closed;
    assert.equal(state.pending.size, 0);
    assert.equal(lines.listenerCount("line"), 0);
    await assert.rejects(request(child, nextId, lines, "tools/list"), { code: "ENOENT" });
  });

  // The red this holds down: restore `MCP_REQUEST_TIMEOUT_MS = 2_000` and this fails as
  // `MCP initialize timed out after 2000 ms`, the message CI produced. The delay is a fixed
  // `setTimeout` inside the server rather than a real cold start, so it asserts the budget that is
  // applied and never races the machine it runs on. `tools/list` is asserted on the same server
  // because scoping the previous repair to `initialize` alone left every other method racing.
  it("outlasts a slow server on every method, not only initialize", async () => {
    const replyAfterMs = 2_500;
    assert.ok(
      replyAfterMs < MCP_REQUEST_TIMEOUT_MS,
      `a ${replyAfterMs} ms reply must fit the ${MCP_REQUEST_TIMEOUT_MS} ms budget`,
    );
    const { child, lines, nextId } = startServer(`
      let id = 0;
      require("node:readline")
        .createInterface({ input: process.stdin })
        .on("line", () => {
          const current = ++id;
          setTimeout(() => {
            process.stdout.write(
              JSON.stringify({ id: current, result: { ready: true } }) + "\\n",
            );
          }, ${replyAfterMs});
        });
      setInterval(() => {}, 1000);
    `);
    assert.deepEqual(await request(child, nextId, lines, "initialize"), { ready: true });
    assert.deepEqual(await request(child, nextId, lines, "tools/list"), { ready: true });
  });

  // Load-bearing form of "a probe's budget stays under its test's budget": assert that no `it` in
  // this file carries a hand-written millisecond literal. Comparing the derived constants against
  // each other cannot fail - `testBudget` builds the budget from the spend, so every such row
  // reduces to `x < margin * x` - and it would not notice the regression it names, because pasting
  // a literal back into an `it(...)` call re-creates exactly the inversion this guards.
  it("derives every per-test budget instead of hand-writing a millisecond literal", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const literals = [...source.matchAll(/\n\x20{2,4}(\d[\d_]*),\n\x20{2}\);/gu)].map(
      (match) => match[1] ?? "",
    );
    assert.deepEqual(
      literals,
      [],
      `per-test budgets must come from testBudget(); found literal timeout(s): ${literals.join(", ")}`,
    );
    // The one budget larger than vitest's own default has to bring its own test budget, or vitest
    // kills the test first and the server stderr goes with it.
    assert.ok(
      MCP_COMPILE_REQUEST_TIMEOUT_MS > 60_000 &&
        COMPILE_PROBE_TEST_TIMEOUT_MS > MCP_COMPILE_REQUEST_TIMEOUT_MS,
      `compile budget ${MCP_COMPILE_REQUEST_TIMEOUT_MS} needs a test budget above it, got ${COMPILE_PROBE_TEST_TIMEOUT_MS}`,
    );
  });

  it("includes stderr and removes listeners when a live server times out", async () => {
    const { child, lines, nextId, state } = startServer(`
      process.stderr.write("still waiting");
      setInterval(() => {}, 1000);
    `);
    // Synchronize on output, not a guessed Node startup delay.
    await new Promise<void>((resolve) => child.stderr.once("data", () => resolve()));
    await assert.rejects(
      request(child, nextId, lines, "initialize", {}, 20),
      /timed out after 20 ms; server stderr: still waiting/,
    );
    assert.equal(state.pending.size, 0);
    assert.equal(lines.listenerCount("line"), 0);
    assert.equal(state.terminal, undefined);
  });
});

async function probeEngineServer(target: string): Promise<void> {
  const config = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { args: string[]; command: string }>;
  };
  const server = config.mcpServers["threenative-engine"];
  if (server === undefined) throw new Error("scaffold has no threenative-engine server");
  const child = spawn(server.command, server.args, {
    cwd: target,
    env: {
      ...process.env,
      THREENATIVE_REFERENCES_URL: "http://127.0.0.1:1/",
      THREENATIVE_REFERENCES_CACHE: path.join(target, ".threenative", "test-reference-cache"),
    },
    stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout });
  const nextId = { value: 1 };
  try {
    const initialized = await request(child, nextId, lines, "initialize", {
      capabilities: {},
      clientInfo: { name: "scaffold-mcp-test", version: "0" },
      protocolVersion: "2025-06-18",
    });
    expect(initialized.instructions).toContain("New games: steps 1-8");
    expect(initialized.instructions).toContain("Existing games: steps 5-7 only");
    expect(initialized.instructions).toContain("subagents focused on specific areas");
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await request(child, nextId, lines, "tools/list");
    const tools = listed.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "engine_search_capabilities",
      "engine_capability_detail",
      "engine_search_references",
      "engine_reference_detail",
      "engine_save_reference",
    ]);
    const called = await request(child, nextId, lines, "tools/call", {
      arguments: { situation: "enemy walks around a wall" },
      name: "engine_search_capabilities",
    });
    const content = called.content as Array<{ text: string }>;
    const parsed = capabilitySearchResponse(JSON.parse(content[0]?.text ?? "null") as unknown);
    expect(parsed.verdict).toBe("matched");
    expect(parsed.guidance).toBe("");
    const results = parsed.results as Array<{
      example: string;
      importPath: string;
      symbol: string;
    }>;
    expect(results.slice(0, 3).map((result) => result.symbol)).toContain("NavigationAgent3D");
    const navigation = results.find((result) => result.symbol === "NavigationAgent3D");
    expect(navigation?.importPath).toBe("@threenative/physics/navigation");
    expect(navigation?.example).toContain('from "@threenative/physics/navigation"');

    const broad = await request(child, nextId, lines, "tools/call", {
      arguments: {
        scope: "request",
        situation:
          "sailing ship on ocean waves with buoyancy, cloth sails in wind, cannonball physics and smoke particles, crew navigating a deck with swords, islands and coastlines, and positional sound",
      },
      name: "engine_search_capabilities",
    });
    const broadContent = broad.content as Array<{ text: string }>;
    const broadResponse = capabilitySearchResponse(
      JSON.parse(broadContent[0]?.text ?? "null") as unknown,
    );
    expect(broadResponse.verdict).toBe("matched");
    expect(broadResponse.guidance).toBe("");
    const broadResults = broadResponse.results as Array<{
      matchedSituation: string;
      symbol: string;
    }>;
    expect(broadResults.map((result) => result.symbol)).toEqual(
      expect.arrayContaining(["FluidField2D", "GPUReadback", "SoftBody3D", "SpectralOcean"]),
    );
    expect(broadResults.every((result) => result.matchedSituation.length > 0)).toBe(true);

    const networking = await request(child, nextId, lines, "tools/call", {
      arguments: {
        scope: "request",
        situation: "exchange authenticated multiplayer messages over WebTransport",
      },
      name: "engine_search_capabilities",
    });
    const networkingContent = networking.content as Array<{ text: string }>;
    const networkingResponse = capabilitySearchResponse(
      JSON.parse(networkingContent[0]?.text ?? "null") as unknown,
    );
    expect(networkingResponse.verdict).toBe("matched");
    const transport = networkingResponse.results.find((result) => result.symbol === "connect");
    expect(transport?.importPath).toBe("@threenative/core/net");

    const detailCall = await request(child, nextId, lines, "tools/call", {
      arguments: { symbol: "connect" },
      name: "engine_capability_detail",
    });
    const detailContent = detailCall.content as Array<{ text: string }>;
    const detail = JSON.parse(detailContent[0]?.text ?? "null") as {
      constraints: string[];
      importPath: string;
      overrides: string[];
      symbol: string;
    };
    expect(detail.symbol).toBe("connect");
    expect(detail.importPath).toBe("@threenative/core/net");
    expect(detail.constraints.join(" ")).toContain("HTTPS");
    expect(detail.constraints.join(" ")).toContain("queues");
    expect(detail.overrides).toEqual(
      expect.arrayContaining([
        "connectTimeoutMs, maxReliableMessageBytes, maxQueuedReliableBytes, and maxQueuedDatagrams are named per-connection limits",
      ]),
    );
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
}

describe("scaffolded engine MCP", () => {
  // One case per template rather than one loop over all of them. A shared budget made every
  // template's cold start compete for the same 30 000 ms, so the tenth server paid for the nine
  // before it and the failure named the whole loop instead of the kit that broke. Same scaffolds,
  // same probes, same assertions - each now carries its own budget and its own name.
  it.each(templates)(
    "starts and discovers networking metadata from the %s template",
    async (template) => {
      const root = await makeTempDir(`threenative-scaffold-mcp-${template}-`);
      temporaryRoots.push(root);
      const { target } = await createProject({ install: false, target: "game", template }, root);
      const authoring = await readFile(
        path.join(target, ".agents/skills/threenative-capabilities/SKILL.md"),
        "utf8",
      );
      expect(authoring).toContain("## New game");
      expect(authoring).toContain("## Existing game");
      expect(authoring).toContain("Use steps 5-7 only");
      expect(authoring).toContain("subagents focused on specific areas");
      await linkEngineMcp(target);
      await linkCore(target);
      await linkPhysics(target);

      const project = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      expect(project.devDependencies?.[engineMcp], template).toBeUndefined();
      // The scaffold ships no manifest: the engine MCP reads the one inside the installed core,
      // which `linkCore` put under `node_modules`, and that is the copy the probe below loads.
      const manifest = JSON.parse(
        await readFile(
          path.join(target, "node_modules/@threenative/core/capabilities.json"),
          "utf8",
        ),
      ) as {
        entries?: unknown[];
      };
      expect(manifest.entries?.length, template).toBeGreaterThan(0);
      await expect(
        readFile(path.join(target, "node_modules/@threenative/physics/package.json"), "utf8"),
      ).resolves.toContain('"name": "@threenative/physics"');
      await probeEngineServer(target);
    },
    MCP_PROBE_TEST_TIMEOUT_MS,
  );
});

describe("scaffolded asset MCP", () => {
  it(
    "exposes the complete creature workflow through the generated agent bundle",
    async () => {
      for (const template of templates) {
        const root = await makeTempDir(`threenative-scaffold-creatures-${template}-`);
        temporaryRoots.push(root);
        const { target } = await createProject({ install: false, target: "game", template }, root);
        // PRD-449: the pages are read from the installed package, not copied into the project.
        const bundleDirectory = path.resolve("packages/create-threenative/agent-docs/references");

        const recipe = await readFile(path.join(bundleDirectory, "creating-creatures.md"), "utf8");
        expect(recipe).toContain("creature_status");
        expect(recipe).toContain("creature_guide");
        expect(recipe).toContain("creature_compile");
        expect(recipe).toContain("creature_preview");
        expect(recipe).toContain("creature_check");
        expect(recipe).toContain("idle");
        expect(recipe).toContain("move");
        expect(recipe).toContain("attack");
        expect(recipe).toContain("independent visual review");
        expect(recipe).toContain("assets/");

        const findingAssets = await readFile(
          path.join(bundleDirectory, "finding-assets.md"),
          "utf8",
        );
        expect(findingAssets).toContain("creating-creatures.md");
        for (const host of [".agents", ".claude"]) {
          await expect(
            readFile(path.join(target, host, "skills", "threenative-assets", "SKILL.md"), "utf8"),
          ).resolves.toContain(
            "node_modules/create-threenative/agent-docs/references/creating-creatures.md",
          );
        }
      }
    },
    SCAFFOLD_ONLY_TEST_TIMEOUT_MS,
  );

  it(
    "runs the published anyCreature loop through the generated assets shim",
    async () => {
      const root = await makeTempDir("threenative-scaffold-asset-");
      temporaryRoots.push(root);
      const { target } = await createProject(
        { install: false, target: "game", template: "minimal" },
        root,
      );
      await mkdir(path.join(target, ".threenative", "creatures"), { recursive: true });
      await mkdir(path.join(target, "assets", "creatures"), { recursive: true });
      await writeFile(
        path.join(target, ".threenative", "creatures", "compact.json"),
        `${JSON.stringify({
          height: 0.6,
          palette: { body: { color: "#888888", rough: 0.8 } },
          joints: { Root: [0, 0.4, 0], Top: { from: "Root", up: 0.6 } },
          chains: { body: ["Root", "Top"] },
          volumes: [
            {
              chain: "body",
              material: "body",
              sides: 8,
              smooth_angle: 20,
              profile: [
                [0, 0.2, 0.2],
                [0.5, 0.25, 0.2],
                [1, 0.1, 0.1],
              ],
            },
          ],
          animations: {
            idle: {
              duration: 1,
              loop: true,
              tracks: {
                Root: {
                  ry: [
                    [0, -2],
                    [0.5, 2],
                    [1, -2],
                  ],
                },
              },
            },
          },
        })}\n`,
      );
      await linkCore(target);
      await linkRegistryAssetMcp(target);

      const config = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, { args: string[]; command: string }>;
      };
      const server = config.mcpServers["threenative-assets"];
      if (server === undefined) throw new Error("scaffold has no threenative-assets server");
      expect(server.args[0]).toBe("./node_modules/@threenative/core/mcp/assets.mjs");

      const child = spawn(server.command, server.args, { cwd: target, stdio: "pipe" });
      const lines = createInterface({ input: child.stdout });
      const nextId = { value: 1 };
      try {
        const initialized = await request(child, nextId, lines, "initialize", {
          capabilities: {},
          clientInfo: { name: "scaffold-asset-test", version: "0" },
          protocolVersion: "2025-06-18",
        });
        expect(initialized.serverInfo).toEqual({ name: "threenative-asset-mcp", version: "0.8.0" });
        child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

        const listed = await request(child, nextId, lines, "tools/list");
        const toolNames = (listed.tools as Array<{ name: string }>).map((tool) => tool.name);
        expect(toolNames).toHaveLength(40);
        expect(toolNames.slice(-3)).toEqual([
          "creature_compile",
          "creature_preview",
          "creature_check",
        ]);
        expect(toolNames).toEqual(
          expect.arrayContaining(["creature_status", "creature_guide", "creature_compile"]),
        );

        const status = toolText(
          await request(
            child,
            nextId,
            lines,
            "tools/call",
            {
              arguments: {},
              name: "creature_status",
            },
            MCP_REQUEST_TIMEOUT_MS,
          ),
        );
        const statusTooling = status.tooling;
        const statusOperations = status.operations;
        expect(isRecord(statusTooling) && isRecord(statusTooling.compiler)).toBe(true);
        expect((statusTooling as Record<string, unknown>).compiler).toMatchObject({
          available: true,
        });
        expect(isRecord(statusOperations) && isRecord(statusOperations.creature_compile)).toBe(
          true,
        );
        expect((statusOperations as Record<string, unknown>).creature_compile).toMatchObject({
          available: true,
        });

        const guide = toolText(
          await request(
            child,
            nextId,
            lines,
            "tools/call",
            {
              arguments: { section: "syntax" },
              name: "creature_guide",
            },
            MCP_REQUEST_TIMEOUT_MS,
          ),
        );
        expect(guide.section).toBe("syntax");
        expect(guide.guide).toEqual(expect.stringContaining('"palette"'));

        const compile = toolText(
          await request(
            child,
            nextId,
            lines,
            "tools/call",
            {
              arguments: {
                outputPath: "assets/creatures/compact.glb",
                specPath: ".threenative/creatures/compact.json",
              },
              name: "creature_compile",
            },
            MCP_COMPILE_REQUEST_TIMEOUT_MS,
          ),
        );
        expect(compile).toMatchObject({
          operation: "creature_compile",
          outputPath: "assets/creatures/compact.glb",
          specPath: ".threenative/creatures/compact.json",
        });
        expect(compile.outputSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
        expect(compile.receiptPath).toEqual(
          expect.stringMatching(/^\.threenative\/creatures\/receipts\/.+\.json$/u),
        );
        const measurements = compile.measurements;
        expect(isRecord(measurements)).toBe(true);
        expect((measurements as Record<string, unknown>).vertices).toEqual(expect.any(Number));
        expect((measurements as Record<string, unknown>).faces).toEqual(expect.any(Number));
        expect((measurements as Record<string, unknown>).joints).toBe(2);

        const output = await readFile(path.join(target, "assets/creatures/compact.glb"));
        expect(output.subarray(0, 4).toString("ascii")).toBe("glTF");
        const receiptPath = compile.receiptPath as string;
        const receipt = JSON.parse(
          await readFile(path.join(target, receiptPath), "utf8"),
        ) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          operation: "creature_compile",
          outputPath: "assets/creatures/compact.glb",
          outputSha256: compile.outputSha256,
        });
      } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        }
      }
    },
    COMPILE_PROBE_TEST_TIMEOUT_MS,
  );
});

// A host whose config the scaffold does not write is a host whose agent silently has no asset,
// sculpt or capability tools — the failure looks like "the framework has no such feature", not
// like a missing file. Every host in `MCP_HOSTS` is checked, so adding one to that table fails
// here until the templates carry it.
describe("scaffolded host MCP configs", () => {
  it(
    "wires every project-scoped agent host from every template",
    async () => {
      for (const template of templates) {
        const root = await makeTempDir(`threenative-scaffold-hosts-${template}-`);
        temporaryRoots.push(root);
        const { target } = await createProject({ install: false, target: "game", template }, root);

        for (const host of MCP_HOSTS) {
          const source = await readFile(path.join(target, host.file), "utf8").catch(
            () => undefined,
          );
          expect(source, `${template} is missing ${host.file} for ${host.label}`).toBeDefined();
          for (const name of Object.keys(MCP_SERVERS)) {
            expect(source, `${template} ${host.file} omits ${name}`).toContain(name);
          }
        }

        const cursor = JSON.parse(
          await readFile(path.join(target, ".cursor/mcp.json"), "utf8"),
        ) as {
          mcpServers: Record<string, { args: string[] }>;
        };
        expect(cursor.mcpServers["threenative-assets"]?.args[0], template).toBe(
          "./node_modules/@threenative/core/mcp/assets.mjs",
        );
        const code = JSON.parse(await readFile(path.join(target, ".vscode/mcp.json"), "utf8")) as {
          servers: Record<string, { type: string }>;
        };
        expect(code.servers["threenative-engine"]?.type, template).toBe("stdio");
      }
    },
    SCAFFOLD_ONLY_TEST_TIMEOUT_MS,
  );
});

// `pnpm sync:mcp` writes these files and `pnpm budgets` runs its `--check`. That gate lives at the
// end of a chain that takes minutes; this one runs in the unit suite, so a hand-edited template
// config is caught by a plain `pnpm test` too. It calls the generator's own comparison rather than
// re-deriving the expectation: a second derivation would be a second generator, green against its
// own copy of the rule.

// The hard case, not the easy one: a server that only works where Blender happens to be installed
// is exactly the failure this gate exists to prevent. The shim is launched over real stdio with
// `PATH` scrubbed and no `THREENATIVE_BLENDER_PATH`, and the assertions read a real `tools/list`
// and a real `tools/call` — never `MCP_SERVERS` asserting about `MCP_SERVERS`.
describe("scaffolded blender MCP", () => {
  it(
    "should list blender tools with no Blender installed",
    async () => {
      const root = await makeTempDir("threenative-scaffold-blender-");
      temporaryRoots.push(root);
      const { target } = await createProject(
        { install: false, target: "game", template: "minimal" },
        root,
      );
      await linkCore(target);
      await linkBlenderMcp(target);

      // The server to probe is looked up in core's table, not spelled here: removing the entry from
      // `MCP_SERVERS` must stop this gate probing it, which is the revert check for the wiring. A
      // hardcoded name would have kept probing the committed template bytes and passed.
      const servers = MCP_SERVERS as Record<string, { args: readonly string[] }>;
      const blenderServerName = Object.keys(servers).find((name) =>
        (servers[name]?.args[0] ?? "").endsWith("/blender.mjs"),
      );
      expect(blenderServerName, "MCP_SERVERS declares no blender server").toBeDefined();
      const config = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, { args: string[]; command: string }>;
      };
      const server = config.mcpServers[blenderServerName ?? ""];
      expect(server?.args[0]).toBe("./node_modules/@threenative/core/mcp/blender.mjs");

      // A PATH with one empty directory: `blender` cannot be found, and neither can anything else,
      // so nothing on this machine can accidentally satisfy the probe.
      const emptyBin = path.join(root, "empty-bin");
      const emptyHome = path.join(root, "empty-home");
      await mkdir(emptyBin, { recursive: true });
      await mkdir(emptyHome, { recursive: true });
      // `process.execPath`, not "node": PATH is scrubbed to a single empty directory so nothing
      // on this machine can satisfy the Blender probe, and that leaves no node on PATH either.
      const child = spawn(process.execPath, [server?.args[0] ?? ""], {
        cwd: target,
        env: {
          ...process.env,
          // An empty HOME as well as an empty PATH: detection also looks in `~/.local/bin`, and a
          // developer machine with Blender installed there would otherwise pass this gate for the
          // opposite reason to the one it is written for.
          HOME: emptyHome,
          PATH: emptyBin,
          THREENATIVE_BLENDER_PATH: "",
          USERPROFILE: emptyHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout });
      const nextId = { value: 1 };
      try {
        await request(child, nextId, lines, "initialize", {
          capabilities: {},
          clientInfo: { name: "scaffold-blender-test", version: "0" },
          protocolVersion: "2025-06-18",
        });
        child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

        const listed = await request(child, nextId, lines, "tools/list");
        const tools = listed.tools as Array<{ name: string }>;
        expect(tools.map((tool) => tool.name)).toContain("blender_status");

        const called = await request(child, nextId, lines, "tools/call", {
          arguments: {},
          name: "blender_status",
        });
        const content = called.content as Array<{ text: string }>;
        const status = JSON.parse(content[0]?.text ?? "null") as {
          available: boolean;
          cause?: string;
          install: Record<string, string>;
          installCommand: string;
        };
        // The whole point: absent Blender is a result an agent can act on, not a dead server.
        expect(status.available).toBe(false);
        expect(status.cause).toBe("blender-missing");
        expect(Object.keys(status.install).sort()).toEqual(["linux", "macos", "windows"]);
        expect(status.installCommand.length).toBeGreaterThan(0);
      } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        }
      }
    },
    MCP_PROBE_TEST_TIMEOUT_MS,
  );
});

describe("committed template MCP host configs", () => {
  it("should keep every template host config equal to the generator output", () => {
    expect(staleHostConfigs()).toEqual([]);
  });
});
