import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";
import type { Page } from "playwright";

import { assertCpuProfileTargetSupported, startBrowserCpuProfile } from "../src/runner/cpuProfile.js";
import { parseStandalonePlaytestArgs } from "../src/runner/config.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

test("--cpu-prof resolves its output path against the project root", () => {
  const config = parseStandalonePlaytestArgs([
    "scenario.json",
    "--project",
    "/project",
    "--cpu-prof",
    "artifacts/out.cpuprofile",
  ]);

  expect(config.cpuProfilePath).toBe("/project/artifacts/out.cpuprofile");
});

test("--cpu-prof is offered on the browser and desktop targets only", () => {
  expect(() => assertCpuProfileTargetSupported("browser", "/tmp/out.cpuprofile")).not.toThrow();
  expect(() => assertCpuProfileTargetSupported("desktop", "/tmp/out.cpuprofile")).not.toThrow();
  // No flag, no constraint — every target still runs.
  expect(() => assertCpuProfileTargetSupported("android", undefined)).not.toThrow();
  for (const target of ["android", "ios"]) {
    expect(() => assertCpuProfileTargetSupported(target, "/tmp/out.cpuprofile"))
      .toThrow(/TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED/);
  }
});

test("the browser profile carries ordered CLOCK_MONOTONIC bounds on Linux only", async () => {
  const dir = await makeTempDir("tn-cpu-profile-");
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) =>
          method === "Profiler.stop"
            ? { profile: { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] } }
            : {},
      }),
    }),
  } as unknown as Page;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const clock = vi.spyOn(process.hrtime, "bigint")
    .mockReturnValueOnce(100_000n)
    .mockReturnValueOnce(104_000n)
    .mockReturnValueOnce(300_000n)
    .mockReturnValueOnce(303_000n);
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    const linux = join(dir, "linux.cpuprofile");
    await (await startBrowserCpuProfile(page, linux)).stop();
    const { clockBounds } = JSON.parse(await readFile(linux, "utf8"));
    const [startBefore, startAfter] = clockBounds.start;
    const [endBefore, endAfter] = clockBounds.end;
    expect(clockBounds.clock).toBe("CLOCK_MONOTONIC");
    expect(clockBounds.start).toEqual([100, 104]);
    expect(clockBounds.end).toEqual([300, 303]);
    expect(startBefore <= startAfter && startAfter <= endBefore && endBefore <= endAfter).toBe(true);
    clock.mockRestore();

    Object.defineProperty(process, "platform", { value: "darwin" });
    const darwin = join(dir, "darwin.cpuprofile");
    await (await startBrowserCpuProfile(page, darwin)).stop();
    expect(JSON.parse(await readFile(darwin, "utf8"))).not.toHaveProperty("clockBounds");
  } finally {
    clock.mockRestore();
    if (platform) Object.defineProperty(process, "platform", platform);
    await rm(dir, { recursive: true, force: true });
  }
});
