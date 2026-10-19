import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as WorkerThreads from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

describe("asset worker pool lifetime", () => {
  it("exits the real compiler with all passes disabled and no workers", async () => {
    const root = await makeTempDir("threenative-no-passes-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/proof.txt"), "unchanged");
    const moduleUrl = pathToFileURL(path.resolve("packages/assets/src/compile.ts")).href;
    const script = `const started = performance.now();
      const mark = (phase) => console.error("TN_ASSETS_WORKER_STAGE " + JSON.stringify({phase, elapsedMs:performance.now()-started}));
      mark("startup");
      const {compileAssets} = await import(${JSON.stringify(moduleUrl)});
      mark("imported");
      const result = await compileAssets({cwd:${JSON.stringify(root)}, concurrency:2,
        config:{audio:"none",models:"none",textures:"none"}});
      mark("compiled");
      if(result.concurrencyUsed!==1 || result.passCosts.length!==0) throw new Error("unexpected worker/pass");
      console.log("empty-chain-exited");`;
    const result = await new Promise<{
      output: string;
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      pid: number | undefined;
      elapsedMs: number;
    }>((resolve, reject) => {
      const started = performance.now();
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ]);
      let output = "";
      let timedOut = false;
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 5000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          output,
          code,
          signal,
          timedOut,
          pid: child.pid,
          elapsedMs: performance.now() - started,
        });
      });
    });
    const diagnostic = JSON.stringify(result);
    expect(result.output, diagnostic).toContain("empty-chain-exited");
    expect(result.code, diagnostic).toBe(0);
    expect(result.signal, diagnostic).toBeNull();
    expect(result.timedOut, diagnostic).toBe(false);
  }, 10000);

  it("terminates every worker when disposed", async () => {
    const moduleUrl = pathToFileURL(path.resolve("packages/assets/src/worker-pool.ts")).href;
    const script = `void import(${JSON.stringify(moduleUrl)}).then(async ({ createPassPool }) => {
      const pool = createPassPool(
        2,
        [{ kind: "texture", needsRuntimeDecoder: true, options: {} }],
        process.cwd(),
      );
      await pool.run("plain.txt", Buffer.from("unchanged"));
      await pool.dispose();
      process.stdout.write("disposed\\n");
    });`;
    const result = await new Promise<{ readonly output: string; readonly timedOut: boolean }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once("error", reject);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ output, timedOut: true });
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve({ output, timedOut: false });
        });
      },
    );

    expect(result.output).toContain("disposed");
    expect(result.timedOut).toBe(false);
  }, 10_000);
});

describe("asset worker pool failure settling", () => {
  function runScript(script: string, timeoutMs = 10_000) {
    const result = new Promise<{ output: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ output, timedOut: true });
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve({ output, timedOut: false });
      });
    });
    return result;
  }

  it("rejects with TN_ASSETS_PASS_FAILED when a pass throws in a real worker", async () => {
    const moduleUrl = pathToFileURL(path.resolve("packages/assets/src/worker-pool.ts")).href;
    const script = `void import(${JSON.stringify(moduleUrl)}).then(async ({ createPassPool }) => {
      const pool = createPassPool(1, [{ kind: "model", needsRuntimeDecoder: true, options: {} }], process.cwd());
      try {
        await pool.run("broken.glb", Buffer.from("not a glb"));
        console.log("no-error");
      } catch (error) {
        console.log("error:" + (error instanceof Error ? error.message : String(error)).slice(0, 80));
      }
      await pool.dispose();
      console.log("done");
    });`;
    const result = await runScript(script);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("TN_ASSETS_PASS_FAILED");
    expect(result.output).toContain("done");
  }, 15_000);

  it("settles queued jobs when the pool is disposed", async () => {
    const moduleUrl = pathToFileURL(path.resolve("packages/assets/src/worker-pool.ts")).href;
    const script = `const wav = (() => {
      const frames = 44100;
      const buffer = Buffer.alloc(44 + frames * 2);
      buffer.write("RIFF", 0, "ascii");
      buffer.writeUInt32LE(36 + frames * 2, 4);
      buffer.write("WAVE", 8, "ascii");
      buffer.write("fmt ", 12, "ascii");
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(1, 22);
      buffer.writeUInt32LE(44100, 24);
      buffer.writeUInt32LE(88200, 28);
      buffer.writeUInt16LE(2, 32);
      buffer.writeUInt16LE(16, 34);
      buffer.write("data", 36, "ascii");
      buffer.writeUInt32LE(frames * 2, 40);
      for (let frame = 0; frame < frames; frame += 1) {
        buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * frame) / 44100) * 16383), 44 + frame * 2);
      }
      return buffer;
    })();
    void import(${JSON.stringify(moduleUrl)}).then(async ({ createPassPool }) => {
      const pool = createPassPool(1, [{ kind: "audio", needsRuntimeDecoder: false, options: {} }], process.cwd());
      const first = pool.run("a.wav", wav).then(() => "first:ok", (error) => "first:" + error.message.slice(0, 40));
      const second = pool.run("b.wav", wav).then(() => "second:ok", (error) => "second:" + error.message.slice(0, 40));
      await pool.dispose();
      console.log(await first);
      console.log(await second);
      console.log("settled");
    });`;
    const result = await runScript(script);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("TN_ASSETS_POOL_DISPOSED");
    expect(result.output).toContain("settled");
  }, 15_000);

  it("rejects run() after dispose()", async () => {
    const moduleUrl = pathToFileURL(path.resolve("packages/assets/src/worker-pool.ts")).href;
    const script = `void import(${JSON.stringify(moduleUrl)}).then(async ({ createPassPool }) => {
      const pool = createPassPool(1, [{ kind: "texture", needsRuntimeDecoder: true, options: {} }], process.cwd());
      await pool.dispose();
      try {
        await pool.run("plain.txt", Buffer.from("unchanged"));
        console.log("no-error");
      } catch (error) {
        console.log("error:" + (error instanceof Error ? error.message : String(error)).slice(0, 60));
      }
    });`;
    const result = await runScript(script);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("TN_ASSETS_POOL_DISPOSED");
  }, 15_000);

  it("settles a queued job when its worker dies mid-job", async () => {
    // A real worker thread cannot be killed on cue from a test, so a fake one stands in and the
    // pool's own exit path is driven directly. The module loads fresh so the mock reaches it alone.
    vi.resetModules();
    const created: FakeWorker[] = [];
    class FakeWorker extends EventEmitter {
      readonly jobs: Array<{ id?: number }> = [];
      constructor() {
        super();
        created.push(this);
      }
      postMessage(message: { id?: number }): void {
        this.jobs.push(message);
      }
      terminate(): Promise<number> {
        this.emit("exit", 1);
        return Promise.resolve(1);
      }
    }
    vi.doMock("node:worker_threads", async (importOriginal) => ({
      ...(await importOriginal<typeof WorkerThreads>()),
      Worker: FakeWorker,
    }));
    try {
      const { createPassPool } = await import("../src/worker-pool.js");
      const pool = createPassPool(1, [], process.cwd());
      const first = pool.run("a.bin", Buffer.from("a")).then(
        () => "first:ok",
        (error: Error) => `first:${error.message}`,
      );
      const second = pool.run("b.bin", Buffer.from("b")).then(
        () => "second:ok",
        (error: Error) => `second:${error.message}`,
      );
      created[0]?.emit("error", new Error("worker crashed"));
      created[0]?.emit("exit", 1);
      // The queued job must reach a replacement worker. A two-second cap turns a stall into a
      // named failure instead of a test timeout.
      const replacement = created[1];
      const job = replacement?.jobs.at(-1);
      replacement?.emit("message", {
        id: job?.id,
        error: "TN_ASSETS_PASS_FAILED: replacement ran b.bin",
      });
      const settled = await Promise.race([
        second,
        new Promise<string>((resolve) => setTimeout(() => resolve("second:never settled"), 2_000)),
      ]);
      expect(await first).toBe("first:worker crashed");
      expect(settled).toBe("second:TN_ASSETS_PASS_FAILED: replacement ran b.bin");
      await pool.dispose();
    } finally {
      vi.doUnmock("node:worker_threads");
    }
  });
});
