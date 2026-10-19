import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { acquireCaptureLock } from "../src/runner/captureLock.js";
import { createOwnedRunResourceRelease } from "../src/runner/ownedRunResources.js";
import { handlePlaytestSignal } from "../src/runner/runner.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

test("signal waits for pending owned acquisition and releases once before exiting", async () => {
  const events: string[] = [];
  let resolveLease!: (value: { release(): Promise<void> }) => void;
  const pending = new Promise<{ release(): Promise<void> }>((resolve) => { resolveLease = resolve; });
  const release = vi.fn(async () => { events.push("lease-release"); });
  const cleanup = createOwnedRunResourceRelease(undefinedResource, () => pending);
  const signal = handlePlaytestSignal(async () => cleanup(), (code) => events.push(`code:${code}`),
    (code) => events.push(`exit:${code}`), "browser", () => undefined);
  await Promise.resolve();
  expect(events).toEqual([]);
  resolveLease({ release });
  await signal;
  await cleanup();
  expect(events).toEqual(["lease-release", "code:2", "exit:2"]);
  expect(release).toHaveBeenCalledTimes(1);
});

function undefinedResource() { return undefined; }

test("display acquisition/release errors do not skip lease release or duplicate cleanup", async () => {
  for (const failedAcquisition of [false, true]) {
    const events: string[] = [];
    const display = failedAcquisition ? Promise.reject(new Error("display acquisition failed"))
      : Promise.resolve({ release: async () => { events.push("display"); throw new Error("display release failed"); } });
    const lease = Promise.resolve({ release: async () => { events.push("lease"); } });
    const cleanup = createOwnedRunResourceRelease(() => display, () => lease);
    await Promise.all([cleanup(), cleanup()]);
    await cleanup();
    expect(events).toEqual(failedAcquisition ? ["lease"] : ["display", "lease"]);
  }
});

test("real acquired lease cleanup preserves a replacement owner's holder", async () => {
  const root = await makeTempDir("tn-owned-release-");
  try {
    const holder = path.join(root, "lock", "holder.json");
    const lease = await acquireCaptureLock({ lockRoot: root, timeoutMs: 1000 });
    const replacement = { pid: process.pid + 100000, startedAt: "replacement-owner" };
    await writeFile(holder, JSON.stringify(replacement));
    const cleanup = createOwnedRunResourceRelease(undefinedResource, () => Promise.resolve(lease));
    await cleanup();
    await cleanup();
    expect(JSON.parse(await readFile(holder, "utf8"))).toEqual(replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
