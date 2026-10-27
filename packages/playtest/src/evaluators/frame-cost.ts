import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hostDisplayRequested } from "../runner/captureEnvironment.js";

const FRAME_BUDGET = "TN_FRAME_BUDGET:";

/** Which display paced the frames: the runner's private Xvfb (`virtual`) or a real one. */
export type FrameDisplay = "real" | "virtual";

/**
 * On Linux the runner paints on a private Xvfb unless `TN_PLAYTEST_HOST_DISPLAY` asks for the
 * session's display (`decideDisplayStrategy`), and a virtual display paces frames on its own
 * timer. Every other platform paints on a real one.
 */
export function frameDisplay(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): FrameDisplay {
  return platform === "linux" && !hostDisplayRequested(env) ? "virtual" : "real";
}

/**
 * Chromium GPU processes on this host that this run did not start (Linux `/proc`; elsewhere none
 * are seen). Each one shares the GPU with the measured game, so a cost bound it fails is
 * contended: the number holds their load too. A process this run started descends from `ownPid`.
 */
export function foreignGpuProcesses(ownPid: number = process.pid, procRoot = "/proc", platform: string = process.platform): readonly number[] {
  if (platform !== "linux") return [];
  const read = (pid: string, file: string): string | undefined => {
    try {
      return readFileSync(join(procRoot, pid, file), "utf8");
    } catch {
      return undefined; // the process exited between the listing and the read
    }
  };
  const parentOf = (pid: number): number | undefined => {
    const stat = read(String(pid), "stat");
    // `pid (comm) state ppid ...`; comm may hold spaces, so split after its closing parenthesis.
    const ppid = stat === undefined ? undefined : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return ppid === undefined || !Number.isSafeInteger(ppid) ? undefined : ppid;
  };
  const ours = (pid: number): boolean => {
    for (let current: number | undefined = pid, hops = 0; current !== undefined && current > 1 && hops < 64; hops++) {
      if (current === ownPid) return true;
      current = parentOf(current);
    }
    return false;
  };
  return readdirSync(procRoot)
    .filter((entry) => /^\d+$/u.test(entry) && (read(entry, "cmdline") ?? "").split("\0").includes("--type=gpu-process"))
    .map(Number)
    .filter((pid) => !ours(pid))
    .sort((a, b) => a - b);
}

/**
 * The fewest GPU timestamp samples a window may hold and still be judged. No measured value says
 * how many are enough: windows seen on the kits hold 1 to 6 (the engine skips static frames, so an
 * idle wait starves them), and the nearest-rank p95 of fewer than 20 samples is the maximum. 3 means
 * one lucky or one slow query cannot decide the verdict alone.
 */
export const MIN_GPU_SAMPLES = 3;

export interface IGpuWindows {
  /**
   * The GPU p95 of the latest window that measured it, in milliseconds, or `undefined` when no window
   * carried a GPU reading. The first window holds the startup shader compile (an RTS read 196 ms
   * there and 6.4 ms in the next), so the steady state a player is left in is the latest one.
   */
  readonly p95?: number;
  /** The timestamp samples the latest window's p95 rests on, or `undefined` when that window did not count them. */
  readonly samples?: number;
  /** One GPU p95 per `TN_FRAME_BUDGET` window that measured it, in order. */
  readonly windows: readonly number[];
}

/**
 * The engine's own GPU time, read off its `TN_FRAME_BUDGET` windows. A window with no GPU
 * reading (`gpu` absent, or `gpuMs` null because the adapter has no timestamp queries) adds
 * nothing, and with no window at all the GPU is unmeasured, never zero.
 */
export function gpuWindows(consoleLines: readonly unknown[]): IGpuWindows {
  const windows: number[] = [];
  let samples: number | undefined;
  for (const line of consoleLines) {
    if (typeof line !== "string") continue;
    const at = line.indexOf(FRAME_BUDGET);
    if (at === -1) continue;
    let report: { gpu?: { p95?: unknown; samples?: unknown } | null };
    try {
      report = JSON.parse(line.slice(at + FRAME_BUDGET.length)) as typeof report;
    } catch {
      continue;
    }
    const p95 = report.gpu?.p95;
    if (typeof p95 === "number" && Number.isFinite(p95) && (typeof report.gpu?.samples !== "number" || report.gpu.samples > 0)) {
      windows.push(p95);
      samples = typeof report.gpu?.samples === "number" ? report.gpu.samples : undefined;
    }
  }
  return windows.length === 0 ? { windows } : { p95: windows[windows.length - 1], ...(samples === undefined ? {} : { samples }), windows };
}
