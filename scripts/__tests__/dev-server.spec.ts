// The point of the helper is the case the seven local copies got wrong: a server that is already
// dead. The spec spawns a real process that exits at once and asserts the wait fails immediately,
// rather than after the deadline it was given.
import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DevServerError, waitForServer } from "../lib/dev-server.js";

/** A process that exits immediately with `code`, so the wait has a dead child to notice. */
function deadChild(code: number): ChildProcess {
  return spawn(process.execPath, ["-e", `process.exit(${String(code)})`], {
    stdio: "ignore",
  });
}

describe("the dev-server wait", () => {
  it("should refuse at once when the server has already exited", async () => {
    const child = deadChild(1);
    await new Promise((resolve) => child.once("exit", resolve));
    const started = Date.now();
    await expect(
      waitForServer({
        child,
        label: "Visual server",
        timeoutMs: 30_000,
        url: "http://127.0.0.1:1/",
      }),
    ).rejects.toThrow(/TN_DEV_SERVER_EXITED: Visual server exited before answering/u);
    // The deadline was 30s; a wait that noticed the exit cannot have spent it.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("should refuse when the server dies while the wait is running", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 50)"], {
      stdio: "ignore",
    });
    await expect(
      waitForServer({ child, intervalMs: 10, timeoutMs: 30_000, url: "http://127.0.0.1:1/" }),
    ).rejects.toThrow(/TN_DEV_SERVER_EXITED: Dev server exited .*code 3/u);
  });

  it("should name the deadline and the last error when nothing answers", async () => {
    const error = await waitForServer({
      intervalMs: 5,
      label: "Load-test server",
      timeoutMs: 60,
      url: "http://127.0.0.1:1/",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevServerError);
    expect((error as DevServerError).code).toBe("TN_DEV_SERVER_TIMEOUT");
    expect((error as Error).message).toContain("Load-test server did not answer at");
  });

  it("should append the caller's corrective detail to a refusal", async () => {
    const child = deadChild(2);
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(
      waitForServer({
        child,
        detail: "corrective command: pnpm --filter starter dev",
        timeoutMs: 30_000,
        url: "http://127.0.0.1:1/",
      }),
    ).rejects.toThrow(/corrective command: pnpm --filter starter dev/u);
  });
});
