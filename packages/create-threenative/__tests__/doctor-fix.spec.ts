/**
 * PRD-829: `threenative doctor --fix` re-renders the authoring layer of an existing game through the
 * scaffold's own writers. An unedited file is overwritten, an edited one is kept and listed (exit 1)
 * unless `--force`, and a file the package no longer ships is deleted only when unedited.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { authoringLayerStatus, createProject, fixAuthoringLayer } from "../src/index.js";
import { MCP_SERVERS, serverEntryPath } from "../src/mcp-servers.js";

const STAMP = ".threenative/agent-files.json";
const OLD = "0.2.15";
/** The core release this create-threenative pairs with, from core's own manifest. */
const CORE = (
  JSON.parse(readFileSync(new URL("../../core/package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

interface IStamp {
  createThreenative: string;
  kit: string;
  files: Record<string, string>;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The installed package `--fix` writes for: core's manifest at the paired release and every MCP shim
 * it launches. A game without it cannot be paired with, and `--fix` refuses before writing.
 */
async function installCore(target: string, version = CORE): Promise<void> {
  const core = path.join(target, "node_modules", "@threenative", "core");
  await mkdir(core, { recursive: true });
  await writeFile(
    path.join(core, "package.json"),
    `${JSON.stringify({ name: "@threenative/core", version })}\n`,
  );
  for (const server of Object.values(MCP_SERVERS)) {
    const shim = path.join(target, serverEntryPath(server));
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(shim, "// core's MCP shim\n");
  }
}

async function scaffold(name = "fox"): Promise<string> {
  const root = await makeTempDir("threenative-doctor-fix-");
  roots.push(root);
  const { target } = await createProject(
    { install: false, target: name, template: "shooter" },
    root,
  );
  await installCore(target);
  return target;
}

async function readStamp(target: string): Promise<IStamp> {
  return JSON.parse(await readFile(path.join(target, STAMP), "utf8")) as IStamp;
}

/**
 * A game an older create-threenative stamped: one router line and one skill differ from the current
 * package, one hook is missing, and one file the package has since dropped is still there unedited.
 */
async function olderGame(): Promise<string> {
  const target = await scaffold();
  const stamp = await readStamp(target);
  const { ".claude/hooks/discovery-gate.mjs": _dropped, ...older } = stamp.files;
  for (const file of ["AGENTS.md", ".agents/skills/ponytail/SKILL.md"]) {
    const bytes = `${await readFile(path.join(target, file), "utf8")}\nolder package line\n`;
    await writeFile(path.join(target, file), bytes);
    older[file] = sha256(bytes);
  }
  await rm(path.join(target, ".claude/hooks/discovery-gate.mjs"));
  await mkdir(path.join(target, "agent-docs"), { recursive: true });
  await writeFile(path.join(target, "agent-docs/old.md"), "dropped page\n");
  older["agent-docs/old.md"] = sha256("dropped page\n");
  await writeFile(
    path.join(target, STAMP),
    `${JSON.stringify({ ...stamp, createThreenative: OLD, files: older }, null, 2)}\n`,
  );
  return target;
}

describe("authoring layer status", () => {
  it("names both versions and the stale file count for an older stamp", async () => {
    const target = await olderGame();
    const status = await authoringLayerStatus(target);
    expect(status).toMatchObject({ kit: "shooter", stamped: OLD });
    expect([...status.stale].sort()).toEqual([
      ".agents/skills/ponytail/SKILL.md",
      ".claude/hooks/discovery-gate.mjs",
      "AGENTS.md",
      "agent-docs/old.md",
    ]);
  });

  it("reads the kit from the router title when a game has no stamp and no kit.json", async () => {
    const target = await scaffold();
    await rm(path.join(target, STAMP));
    const status = await authoringLayerStatus(target);
    expect(status).toMatchObject({ kit: "shooter", stale: [] });
    expect(status.stamped).toBeUndefined();
  });
});

describe("doctor --fix", () => {
  it("leaves an older game byte-equal to a fresh scaffold, and the status then reads current", async () => {
    const target = await olderGame();
    const result = await fixAuthoringLayer(target, { force: false });
    expect(result).toEqual({
      deleted: ["agent-docs/old.md"],
      kept: [],
      written: [
        ".agents/skills/ponytail/SKILL.md",
        ".claude/hooks/discovery-gate.mjs",
        "AGENTS.md",
      ],
    });
    const fresh = await scaffold();
    const stamp = await readStamp(fresh);
    expect(await readStamp(target)).toEqual(stamp);
    for (const file of Object.keys(stamp.files))
      expect(await readFile(path.join(target, file)), file).toEqual(
        await readFile(path.join(fresh, file)),
      );
    expect(existsSync(path.join(target, "agent-docs/old.md"))).toBe(false);
    const status = await authoringLayerStatus(target);
    expect(status.stale).toEqual([]);
    expect(status.stamped).toBe(status.installed);
  });

  it("keeps an AGENTS.md the game edited and lists it; --force overwrites it", async () => {
    const target = await scaffold();
    const stamp = await readStamp(target);
    await writeFile(
      path.join(target, STAMP),
      `${JSON.stringify({ ...stamp, createThreenative: OLD }, null, 2)}\n`,
    );
    const edited = "# AGENTS.md — fox\nThis game owns its router.\n";
    await writeFile(path.join(target, "AGENTS.md"), edited);
    const kept = await fixAuthoringLayer(target, { force: false });
    expect(kept.kept).toEqual(["AGENTS.md"]);
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toBe(edited);
    // The stamp keeps the package's bytes, so the next run still sees the edit.
    expect((await readStamp(target)).files["AGENTS.md"]).toBe(stamp.files["AGENTS.md"]);
    const forced = await fixAuthoringLayer(target, { force: true });
    expect(forced).toMatchObject({ kept: [], written: ["AGENTS.md"] });
    expect(sha256(await readFile(path.join(target, "AGENTS.md")))).toBe(stamp.files["AGENTS.md"]);
  });

  it("exits 1 with TN_AUTHORING_LAYER_EDITED when a file was kept", async () => {
    const { runDoctorCommand } = await import("../src/threenative.js");
    const target = await scaffold();
    await writeFile(path.join(target, "AGENTS.md"), "# edited\n");
    const out: string[] = [];
    const write = { stdout: process.stdout.write, stderr: process.stderr.write };
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let exitCode: number;
    try {
      exitCode = await runDoctorCommand(["--fix"], target);
    } finally {
      process.stdout.write = write.stdout;
      process.stderr.write = write.stderr;
    }
    expect(exitCode).toBe(1);
    expect(out.join("")).toContain("kept AGENTS.md");
    expect(out.join("")).toContain("TN_AUTHORING_LAYER_EDITED");
  });

  it("refuses a game on another core release, before it writes anything", async () => {
    const target = await olderGame();
    await installCore(target, "0.3.11");
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const stamp = await readFile(path.join(target, STAMP), "utf8");
    await expect(fixAuthoringLayer(target, { force: true })).rejects.toThrow(
      /TN_AUTHORING_LAYER_PAIR/u,
    );
    await expect(fixAuthoringLayer(target, { force: true })).rejects.toThrow(
      /pnpm up --latest create-threenative @threenative\/\*/u,
    );
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(path.join(target, STAMP), "utf8")).toBe(stamp);
  });

  it("accepts a core newer than the paired release, the normal case for a fresh scaffold", async () => {
    const target = await scaffold();
    const [major, minor] = CORE.split(".").map(Number) as [number, number];
    // Templates ship `>=`, so a game may resolve any newer engine — including a later minor.
    await installCore(target, `${major}.${minor + 1}.0`);
    await expect(fixAuthoringLayer(target, { force: true })).resolves.toEqual({
      deleted: [],
      kept: [],
      written: [],
    });
  });

  it("refuses a game with no installed core at all, and names the upgrade", async () => {
    const target = await olderGame();
    await rm(path.join(target, "node_modules"), { force: true, recursive: true });
    await expect(fixAuthoringLayer(target, { force: true })).rejects.toThrow(
      /TN_AUTHORING_LAYER_PAIR: .*installs no installed core.*pnpm up --latest create-threenative/u,
    );
  });

  it("refuses a core that does not ship an MCP shim, before a config names it", async () => {
    const target = await olderGame();
    await rm(path.join(target, "node_modules/@threenative/core/mcp/terrain.mjs"));
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const config = await readFile(path.join(target, ".mcp.json"), "utf8");
    await expect(fixAuthoringLayer(target, { force: true })).rejects.toThrow(
      /'threenative-terrain' launches '\.\/node_modules\/@threenative\/core\/mcp\/terrain\.mjs'/u,
    );
    expect(await readFile(path.join(target, ".mcp.json"), "utf8")).toBe(config);
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("refuses --force without --fix", async () => {
    const { runDoctorCommand } = await import("../src/threenative.js");
    await expect(runDoctorCommand(["--force"], await scaffold())).rejects.toThrow(
      "doctor: '--force' requires '--fix'.",
    );
  });
});
