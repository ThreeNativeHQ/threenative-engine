import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";

import {
  acquireCaptureLock,
  CaptureLockTimeoutError,
  decideLockPolicy,
  defaultCaptureLockRoot,
  detectCaptureConcurrency,
  formatLockTimeoutLine,
  isProcessAlive,
} from "../src/runner/captureLock.js";

const aliveAlways = () => true;

test("a solo run takes no lock", () => {
  expect(decideLockPolicy({ othersAlive: 0 })).toEqual({ mode: "none" });
});

test("detected concurrency serialises with the long queue timeout", () => {
  expect(decideLockPolicy({ othersAlive: 2 })).toEqual({
    mode: "flock",
    timeoutMs: 120_000,
    trigger: "concurrency",
  });
});

test("CAPTURE_LOCK=1 forces the lock even solo, with the low default timeout", () => {
  expect(decideLockPolicy({ captureLock: "1", othersAlive: 0 })).toEqual({
    mode: "flock",
    timeoutMs: 10_000,
    trigger: "CAPTURE_LOCK",
  });
});

test("CAPTURE_LOCK=true forces too; other values do not", () => {
  expect(decideLockPolicy({ captureLock: "true", othersAlive: 0 }).mode).toBe("flock");
  expect(decideLockPolicy({ captureLock: "yes", othersAlive: 0 })).toEqual({ mode: "none" });
  expect(decideLockPolicy({ captureLock: "0", othersAlive: 0 })).toEqual({ mode: "none" });
});

test("concurrency wins over CAPTURE_LOCK for trigger and keeps the long timeout", () => {
  expect(decideLockPolicy({ captureLock: "1", othersAlive: 3 })).toMatchObject({
    mode: "flock",
    timeoutMs: 120_000,
    trigger: "concurrency",
  });
});

test("CAPTURE_LOCK_TIMEOUT_MS overrides both defaults and must be a positive integer", () => {
  expect(decideLockPolicy({ captureLock: "1", lockTimeoutMs: "5000", othersAlive: 0 })).toMatchObject({
    timeoutMs: 5_000,
  });
  expect(decideLockPolicy({ lockTimeoutMs: "250", othersAlive: 1 })).toMatchObject({ timeoutMs: 250 });
  expect(() => decideLockPolicy({ lockTimeoutMs: "abc", othersAlive: 1 })).toThrow(/CAPTURE_LOCK_TIMEOUT_MS/);
  expect(() => decideLockPolicy({ lockTimeoutMs: "-4", othersAlive: 1 })).toThrow(/CAPTURE_LOCK_TIMEOUT_MS/);
});

test("an absent lock root means nobody else is running", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  try {
    expect(detectCaptureConcurrency({ isProcessAlive: aliveAlways, lockRoot })).toBe(0);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("a live holder counts as concurrency; a dead one does not", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  try {
    const lockDir = join(lockRoot, "lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "holder.json"),
      `${JSON.stringify({ command: "playtest delta", pid: 3000, startedAt: "2026-08-22T00:00:00.000Z" })}\n`,
    );
    expect(detectCaptureConcurrency({ isProcessAlive: (pid) => pid === 3000, lockRoot })).toBe(1);
    expect(detectCaptureConcurrency({ isProcessAlive: () => false, lockRoot })).toBe(0);
    expect(detectCaptureConcurrency({ isProcessAlive: aliveAlways, lockRoot })).toBe(1);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("EPERM from process.kill means the process is alive but not inspectable", () => {
  const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    expect(isProcessAlive(3000)).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

test("a live EPERM holder is queued behind, never stolen", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  const lockDir = join(lockRoot, "lock");
  const holderPath = join(lockDir, "holder.json");
  const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      holderPath,
      `${JSON.stringify({ command: "other uid playtest", pid: 3000, startedAt: "2026-10-18T00:00:00.000Z" })}\n`,
    );
    expect(detectCaptureConcurrency({ isProcessAlive, lockRoot })).toBe(1);
    await expect(
      acquireCaptureLock({ lockRoot, pid: 900, pollIntervalMs: 10, timeoutMs: 40 }),
    ).rejects.toBeInstanceOf(CaptureLockTimeoutError);
    const holder = JSON.parse(await readFile(holderPath, "utf8")) as { pid?: number };
    expect(holder.pid).toBe(3000);
  } finally {
    kill.mockRestore();
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("a malformed holder record fails closed instead of reading as solo", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  try {
    const lockDir = join(lockRoot, "lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "holder.json"), "{not json");
    expect(() => detectCaptureConcurrency({ isProcessAlive: aliveAlways, lockRoot })).toThrow(/holder/);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("acquire, hold, release leaves no residue behind", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  const states: string[] = [];
  try {
    const lease = await acquireCaptureLock({
      command: "playtest alpha",
      isProcessAlive: aliveAlways,
      lockRoot,
      onState: ({ mode }) => states.push(mode),
      pid: 500,
      timeoutMs: 1_000,
    });
    expect(states).toContain("held");
    const holder = JSON.parse(await readFile(join(lockRoot, "lock", "holder.json"), "utf8")) as { pid?: number };
    expect(holder.pid).toBe(500);
    await lease.release();
    await expect(readFile(join(lockRoot, "lock", "holder.json"), "utf8")).rejects.toThrow();
    expect(detectCaptureConcurrency({ isProcessAlive: aliveAlways, lockRoot })).toBe(0);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("a held lock times out naming the holder, and is NOT a test failure", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  try {
    const holderLease = await acquireCaptureLock({
      command: "playtest beta",
      isProcessAlive: aliveAlways,
      lockRoot,
      pid: 4242,
      timeoutMs: 1_000,
    });
    let error: CaptureLockTimeoutError | undefined;
    try {
      await acquireCaptureLock({
        command: "playtest gamma",
        isProcessAlive: aliveAlways,
        lockRoot,
        pollIntervalMs: 20,
        pid: 1111,
        timeoutMs: 120,
      });
    } catch (caught) {
      error = caught as CaptureLockTimeoutError;
    }
    if (!(error instanceof CaptureLockTimeoutError)) throw new Error("expected a CaptureLockTimeoutError");
    expect(error.holderSummary).toContain("4242");
    expect(error.holderSummary).toContain("playtest beta");
    expect(typeof error.queueDepth).toBe("number");
    const line = formatLockTimeoutLine(error);
    expect(line).toContain("LOCK TIMEOUT");
    expect(line).toContain("NOT a test failure");
    expect(line).toContain("4242");
    await holderLease.release();
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("a dead holder's stale lock is stolen, not waited on", async () => {
  const lockRoot = await makeTempDir("tn-capture-lock-");
  try {
    const deadLease = await acquireCaptureLock({
      isProcessAlive: () => false,
      lockRoot,
      pid: 808,
      timeoutMs: 1_000,
    });
    // The first holder was declared dead from the start; the next acquirer steals.
    const started = Date.now();
    const lease = await acquireCaptureLock({
      isProcessAlive: () => false,
      lockRoot,
      pollIntervalMs: 20,
      pid: 909,
      timeoutMs: 2_000,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    await lease.release();
    await deadLease.release().catch(() => undefined);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("the default lock root lives under the OS temp directory", () => {
  expect(defaultCaptureLockRoot()).toContain(tmpdir());
  expect(defaultCaptureLockRoot()).toContain("threenative-playtest-capture");
});
