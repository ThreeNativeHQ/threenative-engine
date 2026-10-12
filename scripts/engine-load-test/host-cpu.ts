// CPU the host process spent inside a rung's timed window, read by the runner. The page cannot read its
// own process CPU time, and wall time drifts with host load and with the present throttle, so the page
// prints a marker where the window opens (`window <mode>@<n>`) and closes (`rung <mode>@<n> ...`) and the
// runner reads /proc/<pid>/stat at each. The process is the whole thing the arm runs: every thread, V8,
// the driver and the GPU submit thread, for both the legacy host and the engine player alike.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { BenchError } from "./report.js";

export interface IWindowCpu {
  /** Where the timed window opened, in the process's CPU milliseconds. */
  begin: number;
  /** `mode@objectCount`. */
  key: string;
  /** CPU milliseconds the process spent between the two markers; undefined while the window is open. */
  cpuMs?: number;
  /**
   * Per-frame main-thread CPU without the swap call (`cpuFrameCpuMs`), when the run asked for TN_PLAYER_METRICS.
   * Both arms print it, on CLOCK_THREAD_CPUTIME_ID.
   */
  threadFrameMs: number[];
  /** The thread CPU inside the surface present call (`presentCpuMs`), same lines, same clock, both arms. */
  presentFrameMs: number[];
  /** C ABI crossings per frame (`bridgeCalls`); only the engine player counts them. */
  crossingsPerFrame: number[];
  /**
   * Thread CPU inside the host's own render call (`renderCpuMs`): the work the engine player's facade
   * `renderer.render` defers until the page's frame is over. Only the engine player prints it.
   */
  renderFrameMs: number[];
}

/** Fields 14 and 15 (utime, stime) and the process group (field 5) of a /proc/<pid>/stat line. */
export function parseProcStat(text: string): { cpuTicks: number; group: number } {
  // The command name sits in parentheses and may hold spaces or parentheses itself: everything after the
  // last ')' is the fixed-width part.
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const group = Number(rest[2]);
  const cpuTicks = Number(rest[11]) + Number(rest[12]);
  if (!Number.isInteger(group) || !Number.isFinite(cpuTicks))
    throw new BenchError("TN_BENCH_PROC_STAT", `unreadable /proc stat line: ${text.slice(0, 120)}`);
  return { cpuTicks, group };
}

let ticksPerSecond: number | undefined;
function clockTicks(): number {
  ticksPerSecond ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  if (!Number.isInteger(ticksPerSecond) || ticksPerSecond < 1)
    throw new BenchError("TN_BENCH_PROC_STAT", "getconf CLK_TCK is unreadable");
  return ticksPerSecond;
}

/**
 * The process of `group` whose executable is `exe`: the arm runs behind a display wrapper, so the group
 * leader is the wrapper and the host is a member. Undefined when it is not (yet) there.
 */
export function findGroupMember(group: number, exe: string, proc = "/proc"): number | undefined {
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = parseProcStat(readFileSync(`${proc}/${name}/stat`, "utf8"));
      if (stat.group !== group) continue;
      const command = readFileSync(`${proc}/${name}/cmdline`, "utf8").split("\0")[0];
      if (command === exe) return Number(name);
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return undefined;
}

export interface IHostCpuSource {
  /** The host's CPU time in ms, or undefined when the process is not found. */
  read(): number | undefined;
}

/** Reads the process of `group` running `exe`, resolved once it exists. */
export function procCpuSource(group: number, exe: string, proc = "/proc"): IHostCpuSource {
  let pid: number | undefined;
  return {
    read() {
      pid ??= findGroupMember(group, exe, proc);
      if (pid === undefined) return undefined;
      try {
        return (
          (parseProcStat(readFileSync(`${proc}/${pid}/stat`, "utf8")).cpuTicks * 1000) /
          clockTicks()
        );
      } catch {
        return undefined;
      }
    },
  };
}

/** Collects the windows a run printed. Feed it every output line. */
export class HostCpuRecorder {
  readonly windows: IWindowCpu[] = [];
  private open: IWindowCpu | undefined;

  constructor(private readonly source: IHostCpuSource) {}

  line(text: string): void {
    const opened = /(?:^|\s)window (\S+@\d+)\s*$/u.exec(text);
    if (opened !== null) {
      const begin = this.source.read();
      if (begin === undefined)
        throw new BenchError(
          "TN_BENCH_CPU_UNREADABLE",
          "the host process was not found at a window marker",
        );
      this.open = {
        begin,
        crossingsPerFrame: [],
        key: opened[1] as string,
        presentFrameMs: [],
        renderFrameMs: [],
        threadFrameMs: [],
      };
      return;
    }
    const closed = /(?:^|\s)rung (\S+@\d+) frame /u.exec(text);
    if (closed !== null && this.open !== undefined) {
      const end = this.source.read();
      if (end === undefined)
        throw new BenchError(
          "TN_BENCH_CPU_UNREADABLE",
          "the host process was not found at a rung marker",
        );
      if (this.open.key !== closed[1])
        throw new BenchError(
          "TN_BENCH_CPU_WINDOWS",
          `window ${this.open.key} was closed by rung ${closed[1]}`,
        );
      this.open.cpuMs = end - this.open.begin;
      this.windows.push(this.open);
      this.open = undefined;
      return;
    }
    const frame = /TN_PLAYER_FRAME:(\{.*\})/u.exec(text);
    if (frame !== null && this.open !== undefined) {
      const sample = JSON.parse(frame[1] as string) as {
        bridgeCalls?: unknown;
        cpuFrameCpuMs?: unknown;
        presentCpuMs?: unknown;
        renderCpuMs?: unknown;
      };
      if (typeof sample.cpuFrameCpuMs === "number")
        this.open.threadFrameMs.push(sample.cpuFrameCpuMs);
      if (typeof sample.presentCpuMs === "number")
        this.open.presentFrameMs.push(sample.presentCpuMs);
      if (typeof sample.bridgeCalls === "number")
        this.open.crossingsPerFrame.push(sample.bridgeCalls);
      if (typeof sample.renderCpuMs === "number") this.open.renderFrameMs.push(sample.renderCpuMs);
    }
  }
}

/**
 * Adds the runner's CPU reading to each rung of a page report, in order. A window that does not pair with
 * its rung, or a rung with no window, is a failed run: a CPU figure that is not for this rung's frames is
 * worse than none.
 */
export function withHostCpu(
  report: unknown,
  recorder: HostCpuRecorder,
  requireThreadCpu = false,
): unknown {
  const root = report as { rungs?: Array<Record<string, unknown>> };
  const rungs = root.rungs;
  if (!Array.isArray(rungs))
    throw new BenchError("TN_BENCH_BAD_SHAPE", "report.rungs is not an array");
  if (recorder.windows.length !== rungs.length)
    throw new BenchError(
      "TN_BENCH_CPU_WINDOWS",
      `${recorder.windows.length} timed windows for ${rungs.length} rungs`,
    );
  return {
    ...root,
    rungs: rungs.map((rung, index) => {
      const window = recorder.windows[index] as IWindowCpu;
      const key = `${String(rung.mode)}@${String(rung.objectCount)}`;
      const frames = (rung.frameMs as unknown[]).length;
      if (window.key !== key)
        throw new BenchError(
          "TN_BENCH_CPU_WINDOWS",
          `rung ${index} is ${key} but its window is ${window.key}`,
        );
      if (window.cpuMs === undefined || window.cpuMs < 0)
        throw new BenchError("TN_BENCH_CPU_WINDOWS", `window ${key} never closed`);
      const thread = window.threadFrameMs;
      // The player prints one sample per drawn frame and the page measures `frames` of them, give or take the
      // frames in flight at each marker.
      if (requireThreadCpu && (thread.length < frames * 0.9 || thread.length > frames * 1.1 + 2))
        throw new BenchError(
          "TN_BENCH_CPU_WINDOWS",
          `window ${key} carries ${thread.length} player frame samples for ${frames} measured frames`,
        );
      return {
        ...rung,
        cpuMsPerFrame: Math.round((window.cpuMs / frames) * 1000) / 1000,
        ...(thread.length === 0
          ? {}
          : { threadCpuMs: thread.map((value) => Math.round(value * 1000) / 1000) }),
        ...(window.presentFrameMs.length === 0
          ? {}
          : {
              presentCpuMs: window.presentFrameMs.map((value) => Math.round(value * 1000) / 1000),
            }),
        ...(window.crossingsPerFrame.length === 0 ? {} : { bridgeCalls: window.crossingsPerFrame }),
        ...(window.renderFrameMs.length === 0
          ? {}
          : { renderCpuMs: window.renderFrameMs.map((value) => Math.round(value * 1000) / 1000) }),
      };
    }),
  };
}
