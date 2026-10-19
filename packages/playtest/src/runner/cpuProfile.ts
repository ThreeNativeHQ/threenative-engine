import { writeFile } from "node:fs/promises";

import type { Page } from "playwright";

/**
 * `threenative-playtest <scenario> --cpu-prof <path>` on a browser target.
 *
 * The `trace` command folds the same `disabled-by-default-v8.cpu_profiler` data into a summary;
 * this writes the loadable artifact instead, so a run can be opened in Chrome DevTools' Performance
 * panel. CDP owns the format, so nothing here re-implements it.
 */
export interface IBrowserCpuProfile {
  /** Write the profile and return its path, or throw if the CDP session is gone. */
  stop(): Promise<string>;
}

export async function startBrowserCpuProfile(
  page: Page,
  outputPath: string,
): Promise<IBrowserCpuProfile> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  const startBefore = monotonicMicros();
  await cdp.send("Profiler.start");
  const startAfter = monotonicMicros();
  return {
    async stop(): Promise<string> {
      const endBefore = monotonicMicros();
      const { profile } = await cdp.send("Profiler.stop");
      const endAfter = monotonicMicros();
      const clockBounds = {
        clock: "CLOCK_MONOTONIC",
        start: [startBefore, startAfter],
        end: [endBefore, endAfter],
      };
      const output = process.platform === "linux" ? { ...profile, clockBounds } : profile;
      await writeFile(outputPath, `${JSON.stringify(output)}\n`);
      return outputPath;
    },
  };
}

/** Node's `process.hrtime` reads CLOCK_MONOTONIC on Linux, the clock the native host stamps too. */
function monotonicMicros(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/** `--cpu-prof` is a browser and desktop capability; a device lane must say so, not skip it. */
export function assertCpuProfileTargetSupported(target: string, cpuProfilePath: string | undefined): void {
  if (cpuProfilePath === undefined) return;
  if (target === "browser" || target === "desktop") return;
  throw new Error(
    `TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED: --cpu-prof is not supported on the ${target} target; use the browser or desktop target.`,
  );
}
