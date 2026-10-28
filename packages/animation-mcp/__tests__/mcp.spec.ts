import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeRigFixture } from "./rig-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRY = path.resolve(ROOT, "packages", "animation-mcp", "src", "index.ts");

interface Response {
  error?: { message: string };
  id?: number;
  result?: {
    structuredContent?: Record<string, unknown>;
    tools?: { name: string }[];
  };
}

/** Speaks the stdio protocol the way a host does: newline-delimited JSON-RPC on the server's own
 * stdin and stdout, started from the source so the spec proves the entry point a project runs. */
function session() {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (value: Response) => void>();
  const errors: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Response;
      if (message.id === undefined) continue;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out. ${errors.join("")}`)),
        30_000,
      );
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    });
  };
  return {
    child,
    close: () => child.kill(),
    errors,
    notify: (method: string) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    send,
  };
}

/** The path an installed package actually runs: `node_modules/.bin/<name>` is a symlink, and a
 * server that compares `argv[1]` to `import.meta.url` literally starts nothing through it. */
async function linkedBin(directory: string): Promise<string> {
  const link = path.join(directory, "threenative-animation-mcp");
  await symlink(ENTRY, link);
  return link;
}

const BUNDLE = path.resolve(ROOT, "packages", "animation-mcp", "dist", "index.js");

describe("threenative-animation stdio server", () => {
  // The committed bundle is what a game actually runs, and it inlines every module — so a module
  // with a top-level CLI block fires inside it. That printed `Pose Lab: http://...` on stdout, the
  // JSON-RPC stream, before the first response. Skipped until the package is built (CI builds the
  // workspace before its units).
  it.skipIf(!existsSync(BUNDLE))(
    "writes nothing but JSON-RPC to stdout",
    async () => {
      const child = spawn(process.execPath, [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
      try {
        const firstLine = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("the built server said nothing")),
            30_000,
          );
          let buffer = "";
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const line = buffer.split("\n")[0] ?? "";
            if (line.includes("\n") || buffer.includes("\n")) {
              clearTimeout(timer);
              resolve(line);
            }
          });
          child.stdin.write(
            `${JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "initialize",
              params: {
                capabilities: {},
                clientInfo: { name: "spec", version: "0.0.0" },
                protocolVersion: "2025-06-18",
              },
            })}\n`,
          );
        });
        expect(() => JSON.parse(firstLine) as unknown).not.toThrow();
        expect(JSON.parse(firstLine)).toMatchObject({ id: 1 });
      } finally {
        child.kill();
      }
    },
    40_000,
  );

  it("answers when it is started through the bin symlink an install creates", async () => {
    const directory = await makeTempDir("animation-mcp-bin-");
    const link = await linkedBin(directory);
    const child = spawn(process.execPath, ["--import", "tsx", link], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const errors: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    try {
      const answered = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 30_000);
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes('"protocolVersion"')) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        child.stdin.write(
          `${JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: "spec", version: "0.0.0" },
              protocolVersion: "2025-06-18",
            },
          })}\n`,
        );
      });
      expect(answered, `no initialize through the symlink. ${errors.join("")}`).toBe(true);
    } finally {
      child.kill();
    }
  }, 40_000);

  it("answers tools/list with every tool it implements", async () => {
    const server = session();
    try {
      const initialized = await server.send("initialize", {
        capabilities: {},
        clientInfo: { name: "spec", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });
      expect(initialized.error).toBeUndefined();
      server.notify("notifications/initialized");

      const listed = await server.send("tools/list");
      expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual([
        "animation_attach",
        "animation_inspect",
        "animation_open_view",
      ]);
    } finally {
      server.close();
    }
  });

  it("inspects a local rig through a tools/call", async () => {
    const directory = await makeTempDir("animation-mcp-");
    const { host } = await writeRigFixture(directory, ["RifleIdle"]);
    const server = session();
    try {
      await server.send("initialize", {
        capabilities: {},
        clientInfo: { name: "spec", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });
      server.notify("notifications/initialized");

      const called = await server.send("tools/call", {
        arguments: { file: host },
        name: "animation_inspect",
      });

      expect(called.error).toBeUndefined();
      const report = called.result?.structuredContent ?? {};
      expect(report.bones).toEqual(["mixamorigHips", "mixamorigRightHand_035"]);
      expect(report.inPlace).toBe(true);
    } finally {
      server.close();
    }
  });

  it("reports an unknown file as a tool error, not a crash", async () => {
    const directory = await makeTempDir("animation-mcp-missing-");
    const server = session();
    try {
      await server.send("initialize", {
        capabilities: {},
        clientInfo: { name: "spec", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });
      server.notify("notifications/initialized");

      const called = await server.send("tools/call", {
        arguments: { file: path.join(directory, "absent.glb") },
        name: "animation_inspect",
      });

      expect(called.error).toBeUndefined();
      expect(JSON.stringify(called.result)).toMatch(/absent\.glb|ENOENT/u);
    } finally {
      server.close();
    }
  });
});
