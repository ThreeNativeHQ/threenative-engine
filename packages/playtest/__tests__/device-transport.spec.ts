import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";

import {
  androidMailboxPaths,
  DeviceBridgeTransport,
  DeviceMailboxTransport,
  type IDeviceResponseObservation,
  type IDeviceMailbox,
  type IDevicePlaytestTransport,
  validateDeviceEndpoint,
} from "../src/runner/deviceTransport.js";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

test("device transport correlates a polled request with its response", async () => {
  const endpoint = `http://127.0.0.1:${await freePort()}/playtest`;
  const transport = new DeviceBridgeTransport(endpoint);
  await transport.start();
  try {
    const connected = transport.waitForBridge(1_000);
    expect((await fetch(endpoint)).status).toBe(204);
    await expect(connected).resolves.toBe(true);

    const result = transport.call<{ ok: boolean }>("sample", { entities: ["player"] });
    const request = await fetch(endpoint);
    expect(request.status).toBe(200);
    const payload = (await request.json()) as { argument: unknown; id: string; method: string };
    expect(payload).toMatchObject({ argument: { entities: ["player"] }, method: "sample" });

    const response = await fetch(endpoint, {
      body: JSON.stringify({ id: payload.id, result: { ok: true } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(204);
    await expect(result).resolves.toEqual({ ok: true });
  } finally {
    await transport.close();
  }
});

test("device endpoint validation rejects non-loopback or ambiguous endpoints", () => {
  expect(validateDeviceEndpoint("http://localhost:41777/playtest").pathname).toBe("/playtest");
  expect(() => validateDeviceEndpoint("https://127.0.0.1:41777/playtest")).toThrow(/http/u);
  expect(() => validateDeviceEndpoint("http://192.168.0.2:41777/playtest")).toThrow(/loopback/u);
  expect(() => validateDeviceEndpoint("http://127.0.0.1:41777/playtest?x=1")).toThrow(/query/u);
});

test("Android mailbox transport consumes the native ready handshake and correlates calls", async () => {
  const paths = androidMailboxPaths("com.example.game", "/device-files");
  const mailbox = new FakeMailbox(paths);
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(1_000)).resolves.toBe(true);
    await expect(transport.call<{ ok: boolean }>("sample", { entities: ["player"] }))
      .resolves.toEqual({ ok: true });
    expect(mailbox.requests).toEqual([{ entities: ["player"] }]);
  } finally {
    await transport.close();
  }
});

test("Android mailbox transport skips the late answer to a call that already timed out", async () => {
  const paths = androidMailboxPaths("com.example.game", "/late-device-files");
  // The fake never answers inside the test: this one writes the responses itself, in the order a
  // slow host produces them.
  const mailbox = new FakeMailbox(paths, 30_000);
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(1_000)).resolves.toBe(true);
    // A startup poll gives up after its operation timeout on a slow machine and polls again.
    await expect(transport.call("slow", undefined, 20)).rejects.toMatchObject({
      diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" },
    });
    const next = transport.call<{ ok: boolean }>("next", undefined, 2_000);
    // The host finally answers the abandoned call, and only then the one that is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 40));
    mailbox.files.set(paths.response, JSON.stringify({ id: "1", result: { stale: true } }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    mailbox.files.set(paths.response, JSON.stringify({ id: "2", result: { ok: true } }));
    await expect(next).resolves.toEqual({ ok: true });
  } finally {
    await transport.close();
  }
});

test("Android mailbox transport observes the raw response before consuming it", async () => {
  const paths = androidMailboxPaths("com.example.game", "/observed-device-files");
  const mailbox = new FakeMailbox(paths);
  const transport = new DeviceMailboxTransport(mailbox, paths);
  const observations: IDeviceResponseObservation[] = [];
  transport.setResponseObserver((observation) => observations.push(observation));
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(1_000)).resolves.toBe(true);
    await expect(transport.call<{ ok: boolean }>("sample", { entities: ["player"] }))
      .resolves.toEqual({ ok: true });
    expect(observations).toEqual([{
      body: JSON.stringify({ id: "1", result: { ok: true } }),
      method: "sample",
      order: 1,
      requestId: "1",
    }]);
    expect(mailbox.files.has(paths.response)).toBe(false);
  } finally {
    await transport.close();
  }
});

test("mailbox operations honor the configured runner timeout", async () => {
  const paths = androidMailboxPaths("com.example.game", "/silent-device-files");
  const files = new Map<string, string>();
  const mailbox: IDeviceMailbox = {
    read: async (path) => files.get(path),
    remove: async (path) => {
      files.delete(path);
    },
    write: async (path, contents) => {
      files.set(path, contents);
    },
  };
  const transport = new DeviceMailboxTransport(mailbox, paths, 20);
  await transport.start();
  try {
    files.set(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(100)).resolves.toBe(true);
    const bounded = Promise.race([
      transport.call("sample"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("custom timeout ignored")), 200)),
    ]);
    await expect(bounded).rejects.toThrow(/exceeded 20ms/u);
  } finally {
    await transport.close();
  }
});

test("mailbox operations honor a longer per-call timeout for slow advances", async () => {
  vi.useFakeTimers();
  const paths = androidMailboxPaths("com.example.game", "/slow-device-files");
  const mailbox = new FakeMailbox(paths, 30);
  const transport = new DeviceMailboxTransport(mailbox, paths, 20);
  const timedTransport: IDevicePlaytestTransport = transport;
  try {
    await transport.start();
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(100)).resolves.toBe(true);
    const call = timedTransport.call("advance", 60, 50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40);
    await expect(call).resolves.toEqual({ ok: true });
  } finally {
    await transport.close();
    vi.useRealTimers();
  }
});

test("a Windows-style EPERM on the mailbox read is retried until the file is readable", async () => {
  const paths = androidMailboxPaths("com.example.game", "/locked-device-files");
  // The AV/file-lock race clears after a couple of tries, exactly as it does on the Windows lane.
  const mailbox = new LockingMailbox(paths, { lockedReads: 2 });
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(1_000)).resolves.toBe(true);
    expect(mailbox.readAttempts).toBeGreaterThan(2);
  } finally {
    await transport.close();
  }
});

test("a lock that outlasts a short retry burst still clears before the operation deadline", async () => {
  const paths = androidMailboxPaths("com.example.game", "/slow-locked-device-files");
  // An AV scan can hold the file for longer than any fixed burst of retries; the poll's own
  // deadline, not a separate retry budget, decides when the read has taken too long.
  const mailbox = new LockingMailbox(paths, { lockedReads: 8 });
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(2_000)).resolves.toBe(true);
    expect(mailbox.readAttempts).toBeGreaterThan(8);
  } finally {
    await transport.close();
  }
});

test("a lock that never clears ends as the poll's own timeout, not a raw EPERM", async () => {
  const paths = androidMailboxPaths("com.example.game", "/stuck-device-files");
  const mailbox = new LockingMailbox(paths, { lockedReads: Number.POSITIVE_INFINITY });
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(300)).resolves.toBe(false);
  } finally {
    await transport.close();
  }
});

test("a non-lock mailbox read error is rethrown without retrying", async () => {
  const paths = androidMailboxPaths("com.example.game", "/broken-device-files");
  const mailbox = new LockingMailbox(paths, { lockedReads: Number.POSITIVE_INFINITY, errorCode: "EIO" });
  const transport = new DeviceMailboxTransport(mailbox, paths);
  await transport.start();
  try {
    await mailbox.write(paths.response, JSON.stringify({ id: "ready", result: null }));
    await expect(transport.waitForBridge(1_000)).rejects.toMatchObject({ code: "EIO" });
    expect(mailbox.readAttempts).toBe(1);
  } finally {
    await transport.close();
  }
});

class LockingMailbox implements IDeviceMailbox {
  readAttempts = 0;
  private readonly files = new Map<string, string>();

  constructor(
    private readonly paths: ReturnType<typeof androidMailboxPaths>,
    private readonly options: { lockedReads: number; errorCode?: string },
  ) {}

  async read(path: string): Promise<string | undefined> {
    this.readAttempts += 1;
    if (this.readAttempts <= this.options.lockedReads) {
      throw Object.assign(
        new Error(`${this.options.errorCode ?? "EPERM"}: operation not permitted, lstat`),
        { code: this.options.errorCode ?? "EPERM" },
      );
    }
    return this.files.get(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
}

class FakeMailbox implements IDeviceMailbox {
  readonly files = new Map<string, string>();
  readonly requests: unknown[] = [];

  constructor(
    private readonly paths: ReturnType<typeof androidMailboxPaths>,
    private readonly responseDelayMs = 0,
  ) {}

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    if (path !== this.paths.request) return;
    const request = JSON.parse(contents) as { argument?: unknown; id: string };
    this.requests.push(request.argument);
    setTimeout(() => {
      this.files.set(this.paths.response, JSON.stringify({ id: request.id, result: { ok: true } }));
    }, this.responseDelayMs);
  }
}
