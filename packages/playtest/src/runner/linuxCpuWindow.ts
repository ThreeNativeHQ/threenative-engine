import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "playwright";
import type { IPlaytestObservationSnapshot } from "../protocol.js";
import type { IPlaytestScenario } from "../scenario.js";
import type { IPlaytestBridgeClient } from "./bridgeClient.js";

const execute = promisify(execFile);
const FRAMES = 1000;
const fail = (reason: string): never => {
  throw new Error(`TN_PLAYTEST_CPU_WINDOW_FAILED: ${reason}`);
};

export interface ICpuWindow {
  label: string;
  frames: number;
  startTick: number;
  endTick: number;
  updates: number;
  renders: number;
  mainThread: {
    pid: number;
    tid: number;
    starttime: string;
    cpuNs: number;
    cpuMs: number;
    cpuMsPerFrame: number;
    instructions: number;
    instructionsPerFrame: number;
    cycles: number;
    cyclesPerFrame: number;
  };
  processTree: { cpuMs: number; pids: number[] };
  host: { load: number[]; governors: Record<string, string> };
}

export function cpuWindowLabels(
  scenario: Pick<IPlaytestScenario, "steps">,
  target: string,
  liveClock: boolean,
  raw: string | undefined = process.env.TN_PLAYTEST_CPU_WINDOW_LABELS,
): string[] {
  if (raw === undefined) return [];
  if (process.platform !== "linux" || !["browser", "desktop"].includes(target) || liveClock)
    fail(
      "requires local Linux browser/desktop with a fixed-step clock; Android/WASM device counters are unavailable",
    );
  let labels: unknown;
  try {
    labels = JSON.parse(raw);
  } catch {
    fail("labels must be a JSON array");
  }
  if (
    !Array.isArray(labels) ||
    labels.length === 0 ||
    labels.some((label) => typeof label !== "string" || label.length === 0) ||
    new Set(labels).size !== labels.length
  )
    fail("labels must be nonempty, unique strings");
  for (const label of labels as string[]) {
    const matches = scenario.steps.filter((step) => step.label === label);
    const step = matches[0];
    if (
      matches.length !== 1 ||
      step === undefined ||
      step.kind !== "wait" ||
      step.waitTicks !== FRAMES ||
      (step.holdFrames ?? 0) !== 0 ||
      step.waitFrames !== undefined ||
      step.waitForResource !== undefined ||
      step.lifecycle !== undefined
    )
      fail(`'${label}' must identify exactly one WAIT advance with waitTicks=1000`);
  }
  return labels as string[];
}

function frameCounts(snapshot: Pick<IPlaytestObservationSnapshot, "resources">): {
  updates: number;
  renders: number;
} {
  const value = snapshot.resources?.__threenativeFrameCounts;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("missing __threenativeFrameCounts");
  const { updates, renders } = value;
  if (
    typeof updates !== "number" ||
    typeof renders !== "number" ||
    !Number.isSafeInteger(updates) ||
    !Number.isSafeInteger(renders) ||
    updates < 0 ||
    renders < 0
  )
    return fail("invalid frame counters");
  return { updates, renders };
}

export function frameCountDelta(
  before: Pick<IPlaytestObservationSnapshot, "resources">,
  after: Pick<IPlaytestObservationSnapshot, "resources">,
): { updates: number; renders: number } {
  const first = frameCounts(before);
  const last = frameCounts(after);
  const updates = last.updates - first.updates;
  const renders = last.renders - first.renders;
  if (updates !== FRAMES || renders !== FRAMES)
    fail(`expected 1000 updates/renders, observed ${updates}/${renders}`);
  return { updates, renders };
}

interface IProcStat {
  starttime: string;
  jiffies: number;
}
function procStat(raw: string, expectedPid: number): IProcStat {
  const end = raw.lastIndexOf(")");
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  const starttime = fields[19];
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  if (
    Number(raw.slice(0, raw.indexOf(" "))) !== expectedPid ||
    end < 0 ||
    starttime === undefined ||
    !/^\d+$/u.test(starttime) ||
    !Number.isSafeInteger(user) ||
    user < 0 ||
    !Number.isSafeInteger(system) ||
    system < 0 ||
    !Number.isSafeInteger(user + system)
  )
    return fail("malformed /proc stat");
  return { starttime, jiffies: user + system };
}

export function processTreeDelta(
  before: Map<number, IProcStat>,
  after: Map<number, IProcStat>,
  hz: number,
): ICpuWindow["processTree"] {
  if (!Number.isSafeInteger(hz) || hz <= 0 || before.size === 0 || before.size !== after.size)
    return fail("owned process tree changed");
  let jiffies = 0;
  for (const [pid, first] of before) {
    const last = after.get(pid);
    if (last === undefined || first.starttime !== last.starttime || last.jiffies < first.jiffies)
      return fail(`owned process ${pid} disappeared, changed identity or regressed`);
    jiffies += last.jiffies - first.jiffies;
  }
  if (!Number.isSafeInteger(jiffies)) fail("process-tree CPU counter exceeded integer precision");
  return { cpuMs: (jiffies * 1000) / hz, pids: [...before.keys()].sort((a, b) => a - b) };
}

export function parsePerfCounters(raw: string): { instructions: number; cycles: number } {
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0 || line.startsWith("#")) continue;
    const [value, , event, runtime, percent] = line.split(";");
    if (event !== "instructions:u" && event !== "cycles:u")
      return fail(`unexpected/lost perf event: ${line}`);
    const count = Number(value);
    if (
      counts.has(event) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      !(Number(runtime) > 0) ||
      percent?.trim() !== "100.00"
    )
      return fail(`unavailable, scaled or multiplexed perf counter: ${line}`);
    counts.set(event, count);
  }
  const instructions = counts.get("instructions:u");
  const cycles = counts.get("cycles:u");
  if (instructions === undefined || cycles === undefined)
    return fail("missing instructions/cycles counters");
  return { instructions, cycles };
}

export interface ICpuProcess {
  rootPid: number;
  pid: number;
  tid: number;
  renderer?: boolean;
}

export async function browserCpuProcess(
  browser: Browser,
  procRoot = "/proc",
): Promise<ICpuProcess> {
  if (browser.contexts().length !== 1 || browser.contexts()[0]?.pages().length !== 1)
    return fail("browser counters require an isolated one-page run");
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const renderers = processInfo.filter((info) => info.type === "renderer");
    const roots = processInfo.filter((info) => info.type === "browser");
    if (renderers.length !== 1 || roots.length !== 1)
      return fail("ambiguous Chromium renderer/browser processes");
    const pid = renderers[0]?.id;
    const rootPid = roots[0]?.id;
    if (pid === undefined || rootPid === undefined)
      return fail("missing Chromium process identity");
    const tids = await readdir(join(procRoot, `${pid}/task`));
    const main = [];
    for (const tid of tids) {
      const comm = (await readFile(join(procRoot, `${pid}/task/${tid}/comm`), "utf8")).trim();
      if (comm === "CrRendererMain".slice(0, 15)) main.push(Number(tid));
    }
    const tid = main[0];
    if (main.length !== 1 || tid === undefined)
      return fail("renderer has no unambiguous CrRendererMain TID");
    return { rootPid, pid, tid, renderer: true };
  } finally {
    await session.detach();
  }
}

async function readTree(rootPid: number, procRoot: string): Promise<Map<number, IProcStat>> {
  const tree = new Map<number, IProcStat>();
  const queue = [rootPid];
  for (const pid of queue) {
    if (tree.has(pid)) continue;
    tree.set(pid, procStat(await readFile(join(procRoot, `${pid}/stat`), "utf8"), pid));
    // A child may be forked by any thread, not only the leader.
    for (const tid of await readdir(join(procRoot, `${pid}/task`))) {
      const children = (
        await readFile(join(procRoot, `${pid}/task/${tid}/children`), "utf8")
      ).trim();
      if (children.length > 0)
        for (const child of children.split(/\s+/u)) {
          if (!/^\d+$/u.test(child) || Number(child) <= 0) fail("invalid owned child PID");
          queue.push(Number(child));
        }
    }
  }
  return tree;
}

async function readThread(
  owner: ICpuProcess,
  procRoot: string,
): Promise<{ starttime: string; cpuNs: number }> {
  const path = join(procRoot, `${owner.pid}/task/${owner.tid}`);
  const stat = procStat(await readFile(join(path, "stat"), "utf8"), owner.tid);
  if (
    owner.renderer &&
    (await readFile(join(path, "comm"), "utf8")).trim() !== "CrRendererMain".slice(0, 15)
  )
    fail("renderer thread identity changed");
  if (!owner.renderer && owner.tid !== owner.pid) fail("native main TID must equal child PID");
  const schedstat = (await readFile(join(path, "schedstat"), "utf8")).trim();
  if (!/^\d+\s+\d+\s+\d+$/u.test(schedstat)) fail("malformed schedstat runtime");
  const cpuNs = Number(schedstat.split(/\s+/u)[0]);
  if (!Number.isSafeInteger(cpuNs) || cpuNs < 0) return fail("invalid schedstat runtime");
  return { starttime: stat.starttime, cpuNs };
}

async function hostState(procRoot: string, sysRoot: string): Promise<ICpuWindow["host"]> {
  const load = (await readFile(join(procRoot, "loadavg"), "utf8"))
    .trim()
    .split(/\s+/u)
    .slice(0, 3)
    .map(Number);
  if (load.length !== 3 || load.some((value) => !Number.isFinite(value) || value < 0))
    return fail("invalid host load averages");
  const governors: Record<string, string> = {};
  const path = join(sysRoot, "devices/system/cpu/cpufreq");
  let policies: string[];
  try {
    policies = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    policies = [];
  }
  for (const policy of policies) {
    if (!/^policy\d+$/u.test(policy)) continue;
    const governor = (await readFile(join(path, policy, "scaling_governor"), "utf8")).trim();
    if (governor.length === 0) fail("empty CPU governor");
    governors[policy] = governor;
  }
  return { load, governors };
}

/** FIFO ACKs bound counters to the advance, never to screenshot/sample/settling work. */
export async function measureCpuWindow(
  label: string,
  resolveOwner: () => Promise<ICpuProcess>,
  bridge: Pick<IPlaytestBridgeClient, "sample">,
  advance: () => Promise<void>,
  options: { procRoot?: string; sysRoot?: string; perfExecutable?: string; hz?: number } = {},
): Promise<ICpuWindow> {
  if (process.platform !== "linux") return fail("Linux counters unavailable");
  const procRoot = options.procRoot ?? "/proc";
  const owner = await resolveOwner();
  if (![owner.rootPid, owner.pid, owner.tid].every((pid) => Number.isSafeInteger(pid) && pid > 0))
    return fail("invalid owned PID/TID");
  const hz = options.hz ?? Number((await execute("getconf", ["CLK_TCK"])).stdout.trim());
  const host = await hostState(procRoot, options.sysRoot ?? "/sys");
  const root = await mkdtemp(join(tmpdir(), "tn-cpu-window-"));
  const controlPath = join(root, "control");
  const ackPath = join(root, "ack");
  const outputPath = join(root, "stat");
  let control: FileHandle | undefined;
  let ack: FileHandle | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let exited = false;
  let stderr = "";
  let spawnError: Error | undefined;
  try {
    await execute("mkfifo", [controlPath, ackPath]);
    control = await open(controlPath, constants.O_RDWR | constants.O_NONBLOCK);
    ack = await open(ackPath, constants.O_RDWR | constants.O_NONBLOCK);
    child = spawn(
      options.perfExecutable ?? "perf",
      [
        "stat",
        "--no-inherit",
        "--no-scale",
        "-x",
        ";",
        "-o",
        outputPath,
        "-t",
        String(owner.tid),
        "-e",
        "instructions:u,cycles:u",
        "-D",
        "-1",
        `--control=fifo:${controlPath},${ackPath}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LC_ALL: "C" } },
    );
    const perfChild = child;
    const controlFile = control;
    const ackFile = ack;
    closed = new Promise((resolve) =>
      perfChild.once("close", (code) => {
        exited = true;
        resolve(code);
      }),
    );
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    const command = async (name: string): Promise<void> => {
      await controlFile.write(`${name}\n`);
      const buffer = Buffer.alloc(64);
      let reply = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (spawnError !== undefined || exited)
          fail(`perf unavailable: ${spawnError?.message ?? stderr}`);
        try {
          const { bytesRead } = await ackFile.read(buffer, 0, buffer.length, null);
          reply += buffer.subarray(0, bytesRead).toString();
          if (reply.includes("\n")) {
            if (reply.replace(/\0+$/u, "").trim() !== "ack") fail(`invalid perf ACK: ${reply}`);
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      fail(`perf ${name} ACK timed out: ${stderr}`);
    };
    const request = {
      entities: [],
      include: ["resources"],
      resources: ["__threenativeFrameCounts"],
    };
    const beforeFrames = await bridge.sample(request);
    frameCounts(beforeFrames);
    if (beforeFrames.clock?.mode !== "fixed-step")
      fail("live clocks cannot produce matched windows");
    const beforeTree = await readTree(owner.rootPid, procRoot);
    if (!beforeTree.has(owner.pid)) fail("measured process is outside owned tree");
    const before = await readThread(owner, procRoot);
    await command("enable");
    try {
      await advance();
    } finally {
      await command("disable");
    }
    const after = await readThread(owner, procRoot);
    const afterTree = await readTree(owner.rootPid, procRoot);
    const afterFrames = await bridge.sample(request);
    if (afterFrames.clock?.mode !== "fixed-step") fail("clock changed during window");
    const actual = frameCountDelta(beforeFrames, afterFrames);
    const startTick = beforeFrames.clock?.tick;
    const endTick = afterFrames.clock?.tick;
    if (
      typeof startTick !== "number" || typeof endTick !== "number" ||
      ![startTick, endTick].every((tick) => Number.isSafeInteger(tick) && tick >= 0) ||
      endTick - startTick !== FRAMES
    ) fail("expected exact 1000-tick window boundaries");
    const currentOwner = await resolveOwner();
    if (
      owner.pid !== currentOwner.pid ||
      owner.tid !== currentOwner.tid ||
      owner.rootPid !== currentOwner.rootPid ||
      before.starttime !== after.starttime
    )
      fail("measured process/thread identity changed");
    const cpuNs = after.cpuNs - before.cpuNs;
    if (!Number.isSafeInteger(cpuNs) || cpuNs <= 0) fail("schedstat CPU runtime did not advance");
    child.kill("SIGINT");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try {
      code = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("perf exit timed out")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (code !== 0 && !(code === null && child.signalCode === "SIGINT"))
      fail(`perf counters failed (${code}/${child.signalCode}): ${stderr}`);
    const counters = parsePerfCounters(await readFile(outputPath, "utf8"));
    return {
      label,
      frames: FRAMES,
      startTick,
      endTick,
      ...actual,
      mainThread: {
        pid: owner.pid,
        tid: owner.tid,
        starttime: before.starttime,
        cpuNs,
        cpuMs: cpuNs / 1e6,
        cpuMsPerFrame: cpuNs / 1e6 / FRAMES,
        ...counters,
        instructionsPerFrame: counters.instructions / FRAMES,
        cyclesPerFrame: counters.cycles / FRAMES,
      },
      processTree: processTreeDelta(beforeTree, afterTree, hz),
      host,
    };
  } finally {
    if (child !== undefined && !exited) {
      child.kill("SIGKILL");
      await closed;
    }
    try {
      await Promise.all([control?.close(), ack?.close()]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
