import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERIFIER = ["pnpm", "exec", "tsx", "scripts/verify-fluid-consumers.ts"];
const IMAGES = {
  dam: ["gated", "running", "settled", "after"],
  coupling: ["falling", "splash", "settled", "after"],
};
const MAX_LINES = 64;

/** No raw DEBUG line or launch argv crosses the diagnostic boundary. */
export function projectBrowserLine(line, atMs) {
  if (!line.includes("pw:browser")) return null;
  if (line.includes("<launching>")) {
    const allowed = [
      "--enable-unsafe-webgpu",
      "--disable-gpu-sandbox",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--use-angle=swiftshader",
      "--use-vulkan=swiftshader",
      "--disable-gpu-watchdog",
    ];
    const tokens = line.split(/\s+/u);
    const flags = allowed.filter((flag) => tokens.includes(flag));
    return { atMs, event: "launch", ...(flags.length === 0 ? {} : { flags }) };
  }
  const launched = /<launched> pid=(\d+)/u.exec(line);
  if (launched) return { atMs, event: "launched", pid: Number(launched[1]) };
  const exited = /<process did exit: exitCode=(null|\d+), signal=(null|SIG[A-Z0-9]+)>/u.exec(line);
  if (exited)
    return {
      atMs,
      event: "exit",
      code: exited[1] === "null" ? null : Number(exited[1]),
      signal: exited[2] === "null" ? null : exited[2],
    };
  const code = /GPU process exited unexpectedly: exit_code=(-?\d+)/u.exec(line);
  if (code) return { atMs, event: "gpu-process-exit", code: Number(code[1]) };
  const markers = [
    "A valid external Instance reference no longer exists",
    "Instance dropped in popErrorScope",
    "GPU process crashed",
    "GPU process isn't usable",
    "Out of memory",
    "WebGPU Device Lost",
    "TN_DEVICE_LOST",
    "gpu_watchdog_thread.cc",
    "GPU process hung",
  ];
  const marker = markers.find((value) => line.includes(value));
  return marker ? { atMs, event: "gpu-message", marker } : null;
}

export function counterDelta(before, after) {
  if (before === null || after === null) return null;
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      typeof before[key] === "number" && typeof after[key] === "number" && after[key] >= before[key]
        ? after[key] - before[key]
        : null,
    ]),
  );
}

function numbers(text, allowed) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [key, value] = line.trim().split(/\s+/u);
        const number = Number(value);
        return allowed.includes(key) && Number.isSafeInteger(number) && number >= 0
          ? [[key, number]]
          : [];
      }),
  );
}

/** Match the effective cgroup to its mount; do not substitute the host root. */
export function cgroupDirectory(groupText, mountText) {
  const group = /^0::(.+)$/mu.exec(groupText)?.[1];
  if (group === undefined) return null;
  const mount = mountText.split("\n").find((line) => line.includes(" - cgroup2 "));
  if (mount === undefined) return null;
  const [, , , root, point] = mount.split(" ");
  if (group !== root && !group.startsWith(root === "/" ? "/" : `${root}/`)) return null;
  const directory = resolve(point, `.${group.slice(root === "/" ? 0 : root.length)}`);
  return directory === point || directory.startsWith(`${point}/`) ? directory : null;
}

export async function passiveSnapshot() {
  const unavailable = [];
  const read = async (file, name) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      unavailable.push(name);
      return null;
    }
  };
  const cpu = await read("/proc/stat", "cpu");
  const group = await read("/proc/self/cgroup", "cgroup-identity");
  const mounts = await read("/proc/self/mountinfo", "cgroup-mount");
  const directory = group !== null && mounts !== null ? cgroupDirectory(group, mounts) : null;
  const result = {
    cpu:
      cpu === null
        ? null
        : Object.fromEntries(
            cpu
              .split("\n")[0]
              .trim()
              .split(/\s+/u)
              .slice(1, 9)
              .map((value, index) => [String(index), Number(value)]),
          ),
    cgroup: null,
    unavailable,
  };
  if (directory === null) {
    unavailable.push("effective-cgroup-v2");
    return result;
  }
  const values = await Promise.all(
    ["cpu.stat", "memory.events", "memory.current", "memory.peak", "memory.max"].map((name) =>
      read(join(directory, name), name),
    ),
  );
  result.cgroup = {
    scope: "effective-cgroup-v2; counters may include sibling processes",
    cpu:
      values[0] === null
        ? null
        : numbers(values[0], [
            "usage_usec",
            "user_usec",
            "system_usec",
            "nr_periods",
            "nr_throttled",
            "throttled_usec",
            "nr_bursts",
            "burst_usec",
          ]),
    memoryEvents:
      values[1] === null
        ? null
        : numbers(values[1], [
            "low",
            "high",
            "max",
            "oom",
            "oom_kill",
            "oom_group_kill",
            "sock_throttled",
          ]),
    memoryCurrent: scalar(values[2]),
    memoryPeak: scalar(values[3]),
    memoryMax: scalar(values[4]),
    memoryUnlimited: values[4] === null ? null : values[4].trim() === "max",
  };
  return result;
}

function scalar(value) {
  const number = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function safeOrdinaryLine(line) {
  return line
    .replace(/authorization\s*[=:][^\r\n]*/giu, "authorization: <redacted>")
    .replace(
      /((?:token|password|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1<redacted>",
    )
    .replace(/(?:https?:|file:)\/\/[^\s"'<>]+/giu, "<redacted-url>")
    .replace(/[A-Z]:[\\/][^\s"'<>]+|(?:\.{1,2}\/|\/)[^\s"'<>]+/giu, "<redacted-path>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "<redacted-email>")
    .slice(0, 1024);
}

async function freshJson(file, started) {
  try {
    const facts = await stat(file);
    if (facts.mtimeMs < started) return { status: "stale" };
    if (facts.size > 1048576) return { status: "oversized" };
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 1048576) return { status: "oversized" };
    try {
      return { status: "observed", value: JSON.parse(text) };
    } catch {
      return { status: "malformed" };
    }
  } catch {
    return { status: "missing-or-unreadable" };
  }
}

function consoleFact(text) {
  if (typeof text !== "string" || text.length > 8192) return null;
  if (text.startsWith("TN_FRAME_HITCH:")) {
    try {
      const facts = JSON.parse(text.slice("TN_FRAME_HITCH:".length));
      const numeric = Object.fromEntries(
        ["gapMs", "uptimeMs", "wallClock"].flatMap((key) =>
          typeof facts?.[key] === "number" && Number.isFinite(facts[key]) && facts[key] >= 0
            ? [[key, facts[key]]]
            : [],
        ),
      );
      return { marker: "TN_FRAME_HITCH", timestamp: null, ...numeric };
    } catch {
      return null;
    }
  }
  const markers = [
    "TN_DEVICE_LOST",
    "WebGPU Device Lost",
    "A valid external Instance reference no longer exists",
    "Instance dropped in popErrorScope",
    "GPUValidationError",
  ];
  const marker = markers.find((value) => text.startsWith(value));
  if (marker === undefined) return null;
  const reason =
    marker === "TN_DEVICE_LOST" ? /\((unknown|destroyed)\)/u.exec(text)?.[1] : undefined;
  const detail = ["GPU process crashed", "GPU process hung", "Out of memory"].find((value) =>
    text.includes(value),
  );
  return {
    marker,
    timestamp: null,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function captureFacts(value) {
  const rendererKind = ["webgpu", "webgl"].includes(value?.rendererKind)
    ? value.rendererKind
    : null;
  const adapter = Object.fromEntries(
    [
      ["vendor", ["google", "nvidia", "amd", "intel", "apple", "qualcomm", "mesa"]],
      [
        "architecture",
        ["swiftshader", "llvmpipe", "turing", "ampere", "ada", "pascal", "volta", "rdna", "gcn"],
      ],
    ].flatMap(([key, allowed]) =>
      typeof value?.adapter?.[key] === "string" &&
      allowed.includes(value.adapter[key].toLowerCase())
        ? [[key, value.adapter[key].toLowerCase()]]
        : [],
    ),
  );
  const viewport = value?.viewport;
  const validViewport =
    Number.isSafeInteger(viewport?.width) &&
    viewport.width > 0 &&
    Number.isSafeInteger(viewport?.height) &&
    viewport.height > 0;
  return {
    rendererKind,
    adapter,
    viewport: validViewport ? { width: viewport.width, height: viewport.height } : null,
  };
}

/** Only fresh, bounded, known facts cross the existing public artifact boundary. */
export async function collectFluidArtifacts(directory, started) {
  const result = [];
  for (const variant of Object.keys(IMAGES)) {
    const console = await freshJson(join(directory, variant, "console.json"), started);
    const capture = await freshJson(join(directory, variant, "capture.json"), started);
    let projectedConsole = { status: console.status };
    if (console.status === "observed") {
      if (!Array.isArray(console.value)) projectedConsole = { status: "invalid-shape" };
      else {
        const entries = console.value.map((entry) => consoleFact(entry?.text)).filter(Boolean);
        projectedConsole = {
          status: "observed",
          entries: entries.slice(-16),
          truncated: entries.length > 16,
          markers: [...new Set(entries.map(({ marker }) => marker))],
        };
      }
    }
    result.push({
      variant,
      console: projectedConsole,
      capture:
        capture.status === "observed"
          ? capture.value !== null &&
            typeof capture.value === "object" &&
            !Array.isArray(capture.value)
            ? { status: "observed", facts: captureFacts(capture.value) }
            : { status: "invalid-shape" }
          : { status: capture.status },
    });
  }
  return result;
}

/** Observe only this verifier. Collector errors cannot replace its exit status. */
export async function observeFluidCi({
  artifactDirectory = "artifacts/fluid-consumers",
  command = VERIFIER,
  snapshot = passiveSnapshot,
  stderr = (text) => process.stderr.write(text),
  signalSource = process,
  scheduleSampling = (callback) => {
    const timer = setInterval(callback, 5000);
    return () => clearInterval(timer);
  },
} = {}) {
  const started = Date.now();
  const monotonicStart = performance.now();
  const elapsed = () => Math.round(performance.now() - monotonicStart);
  const events = [];
  const samples = [];
  const collectionErrors = [];
  let truncated = false;
  let ordinaryBytes = 0;
  let terminalBrowserExit = null;
  const sample = async () => {
    try {
      return await snapshot();
    } catch {
      collectionErrors.push("snapshot-unavailable");
      return null;
    }
  };
  const before = await sample();
  const childEnvironment = { ...process.env };
  Object.assign(
    childEnvironment,
    Object.fromEntries([
      ["DEBUG", [process.env.DEBUG, "pw:browser"].filter(Boolean).join(",")],
      ["TN_FLUID_CI_OBSERVER", "1"],
    ]),
  );
  const child = spawn(command[0], command.slice(1), {
    stdio: ["inherit", "inherit", "pipe"],
    env: childEnvironment,
  });
  let interruptedBy = null;
  const onInterrupt = (signal) => {
    interruptedBy = signal;
    child.kill(signal);
  };
  const terminate = () => onInterrupt("SIGTERM");
  const interrupt = () => onInterrupt("SIGINT");
  signalSource.on("SIGTERM", terminate);
  signalSource.on("SIGINT", interrupt);
  let buffer = "";
  let droppingLine = false;
  const line = (text) => {
    if (text.length > 8192) {
      truncated = true;
      return;
    }
    if (text.includes("pw:browser")) {
      const event = projectBrowserLine(text, elapsed());
      if (event?.event === "exit") terminalBrowserExit = event;
      if (event && events.length < MAX_LINES) events.push(event);
      else if (event) truncated = true;
    } else if (ordinaryBytes < 32768) {
      const safe = `${safeOrdinaryLine(text)}\n`;
      ordinaryBytes += safe.length;
      try {
        stderr(safe);
      } catch {
        collectionErrors.push("stderr-sink-unavailable");
      }
    }
  };
  child.stderr.on("data", (bytes) => {
    let text = bytes.toString();
    if (droppingLine) {
      const end = text.indexOf("\n");
      if (end < 0) return;
      text = text.slice(end + 1);
      droppingLine = false;
    }
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const text of lines) line(text);
    if (buffer.length > 8192) {
      buffer = "";
      droppingLine = true;
      truncated = true;
    }
  });
  let activeSample = null;
  const stopSampling = scheduleSampling(() => {
    if (activeSample) return activeSample;
    activeSample = (async () => {
      samples.push({ atMs: elapsed(), facts: await sample() });
      if (samples.length > 24) samples.shift();
    })().finally(() => {
      activeSample = null;
    });
    return activeSample;
  });
  const outcome = await new Promise((finish) => {
    child.once("error", () => {
      collectionErrors.push("child-launch-failed");
      finish({ code: 1, signal: null });
    });
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  stopSampling();
  await activeSample;
  signalSource.removeListener("SIGTERM", terminate);
  signalSource.removeListener("SIGINT", interrupt);
  if (buffer) line(buffer);
  const after = await sample();
  let sourceSha = null;
  for (const name of ["failure.json", "summary.json"]) {
    try {
      const file = join(artifactDirectory, name);
      const facts = await stat(file);
      if (facts.mtimeMs < started || facts.size > 1048576) continue;
      const observed = JSON.parse(await readFile(file, "utf8")).sourceSha;
      if (typeof observed === "string" && /^[a-f0-9]{40}$/u.test(observed)) {
        sourceSha = observed;
        break;
      }
    } catch {
      /* Missing source receipts remain unknown. */
    }
  }
  const screenshots = [];
  for (const [variant, names] of Object.entries(IMAGES))
    for (const name of names) {
      try {
        const facts = await stat(join(artifactDirectory, variant, `${name}.png`));
        screenshots.push({
          variant,
          name,
          bytes: facts.size,
          createdMs: facts.birthtimeMs,
          modifiedMs: facts.mtimeMs,
        });
      } catch {
        /* Missing captures are not fabricated. */
      }
    }
  const report = {
    version: 1,
    sourceSha,
    command: "pnpm exec tsx scripts/verify-fluid-consumers.ts",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    child: outcome,
    interruptedBy,
    before,
    after,
    samples,
    cpuDelta: counterDelta(before?.cpu ?? null, after?.cpu ?? null),
    memoryEventDelta: counterDelta(
      before?.cgroup?.memoryEvents ?? null,
      after?.cgroup?.memoryEvents ?? null,
    ),
    cgroupCpuDelta: counterDelta(before?.cgroup?.cpu ?? null, after?.cgroup?.cpu ?? null),
    browserEvents: events,
    terminalBrowserExit,
    browserEventsTruncated: truncated,
    screenshots,
    retainedArtifacts: await collectFluidArtifacts(artifactDirectory, started),
    collectionErrors: [...new Set(collectionErrors)],
  };
  try {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "ci-diagnostics.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch {
    collectionErrors.push("artifact-write-failed");
  }
  return { ...report, collectionErrors: [...new Set(collectionErrors)] };
}

export function observerExitCode(report) {
  return report.interruptedBy === null
    ? (report.child.code ?? 128 + (constants.signals[report.child.signal] ?? 1))
    : 128 + constants.signals[report.interruptedBy];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await observeFluidCi();
  process.exitCode = observerExitCode(report);
}
