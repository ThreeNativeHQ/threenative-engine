import { execFile } from "node:child_process";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface IStackSample {
  time: number;
  /** perf prints the sampled leaf first. */
  frames: string[];
}
type Window = "startup" | "steady" | "all";
export interface IProfileArgs {
  command: "callers" | "top" | "diff";
  files: string[];
  patterns: string[];
  window: Window;
  splitMs?: number;
  buildidDir?: string;
}

export function normalizeSymbol(symbol: string): string {
  let name = symbol.replace(/\+0x[\da-f]+$/, "");
  // perf --demangle handles modern Rust; decode legacy Rust in text fixtures too.
  const legacy = /^_ZN(.+)E$/.exec(name);
  if (legacy) {
    let rest = legacy[1] ?? "";
    const parts: string[] = [];
    while (rest) {
      const size = /^\d+/.exec(rest)?.[0];
      if (!size) break;
      const length = Number(size);
      rest = rest.slice(size.length);
      if (length > rest.length || length === 0) break;
      parts.push(rest.slice(0, length));
      rest = rest.slice(length);
    }
    if (!rest && parts.length) name = parts.join("::");
  }
  return name.replace(/::h[\da-f]{16}$/, "").replace(/^perry_(?:fn|method)_/, "");
}

export function tsFrame(symbol: string): { function: string; module: string } | undefined {
  const name = normalizeSymbol(symbol);
  if (/^(?:js_|_?mi_|__vdso_|0x)|perry_runtime::/.test(name)) return undefined;
  const closure = name.startsWith("perry_closure_");
  const compiled = closure ? name.slice("perry_closure_".length) : name;
  const match = /^([\w$]+_tsx?)(?:__.*)?$/.exec(compiled);
  if (!match) return undefined;
  const module = match[1] ?? "";
  return { function: closure ? `${module} (closure)` : compiled, module };
}

export function parsePerfScript(text: string): IStackSample[] {
  const samples: IStackSample[] = [];
  let sample: IStackSample | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const time = /(?:^|\s)(\d+\.\d+):\s*$/.exec(line);
    if (time) {
      sample = { time: Number(time[1]), frames: [] };
      samples.push(sample);
      continue;
    }
    const frame = /^\s+(?:0x)?[\da-f]+\s+(.+?)\s+\(.*\)\s*$/.exec(line);
    if (!sample || !frame) throw new Error(`Malformed perf script line: ${line.slice(0, 120)}`);
    sample.frames.push(normalizeSymbol(frame[1] ?? ""));
  }
  if (!samples.length) throw new Error("No perf samples");
  for (const entry of samples) {
    if (!entry.frames.length) entry.frames.push("[no callchain]");
  }
  return samples;
}

function markers(text: string, name: string): Array<Record<string, unknown>> {
  // Bench logs are either raw lines or a JSON result containing console entries.
  let lines = text.split(/\r?\n/);
  if (/^\s*[\[{]/.test(text)) {
    const json = JSON.parse(text) as
      | { console?: Array<{ text: string }> }
      | Array<{ text: string }>;
    const entries = Array.isArray(json) ? json : json.console;
    if (entries) lines = entries.map((entry) => entry.text);
  }
  return lines.flatMap((line) => {
    const index = line.indexOf(`${name}:`);
    return index < 0
      ? []
      : [JSON.parse(line.slice(index + name.length + 1)) as Record<string, unknown>];
  });
}

export function selectWindow(
  samples: IStackSample[],
  window: Window,
  splitMs?: number,
  log = "",
): { samples: IStackSample[]; description: string } {
  if (!samples.length) throw new Error("No samples");
  if (window === "all") return { samples, description: "all" };
  let boundary: number;
  let source: string;
  if (splitMs !== undefined) {
    if (!Number.isFinite(splitMs) || splitMs < 0) throw new Error("Invalid --split-ms");
    boundary =
      samples.reduce((first, sample) => Math.min(first, sample.time), Number.POSITIVE_INFINITY) +
      splitMs / 1000;
    source = `explicit split ${splitMs}ms from first sample`;
  } else {
    const clock = markers(log, "TN_PROFILE_CLOCK")[0];
    const first = markers(log, "TN_FRAME_HITCH").find((marker) => marker.uptimeMs === 0);
    if (
      typeof clock?.perfTimeSec !== "number" ||
      typeof clock.wallTimeMs !== "number" ||
      typeof first?.wallClock !== "number"
    )
      throw new Error(
        "No clock-anchored first-frame marker; supply --split-ms <ms from first sample>",
      );
    boundary = clock.perfTimeSec + (first.wallClock - clock.wallTimeMs) / 1000;
    if (!Number.isFinite(boundary)) throw new Error("Invalid first-frame clock marker");
    source = "first-frame wall clock anchored to perf CLOCK_MONOTONIC";
  }
  const selected = samples.filter((sample) =>
    window === "startup" ? sample.time < boundary : sample.time >= boundary,
  );
  if (!selected.length) throw new Error(`No samples in ${window} window`);
  return {
    samples: selected,
    description: `${window}; ${source}; boundary ${boundary.toFixed(6)}s`,
  };
}

function counts(samples: IStackSample[]) {
  const functions = new Map<string, number>();
  const modules = new Map<string, number>();
  const runtime = new Map<string, number>();
  let tsSamples = 0;
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const sample of samples) {
    const frames = sample.frames.flatMap((frame) => {
      const ts = tsFrame(frame);
      return ts ? [ts] : [];
    });
    if (frames.length) tsSamples++;
    for (const name of new Set(frames.map((frame) => frame.function))) add(functions, name);
    for (const name of new Set(frames.map((frame) => frame.module))) add(modules, name);
    const leaf = sample.frames[0];
    if (leaf && !tsFrame(leaf)) add(runtime, leaf);
  }
  return { functions, modules, runtime, tsSamples };
}
const ranked = (map: Map<string, number>) =>
  [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const percent = (count: number, total: number) =>
  `${(total ? (count * 100) / total : 0).toFixed(2)}%`;

export function formatTop(samples: IStackSample[]): string {
  const totals = counts(samples);
  return [
    `Samples: ${samples.length}; inclusive counts deduplicate recursion; runtime/native = non-TS leaves`,
    `TS ancestry: ${totals.tsSamples}/${samples.length} samples (${percent(totals.tsSamples, samples.length)}); inclusive attribution is a lower bound when stacks are incomplete`,
    ...(["functions", "modules", "runtime"] as const).flatMap((kind) => [
      `\n${kind === "runtime" ? "Runtime/native self-time" : `TS ${kind} inclusive`} (top 30)`,
      "% total\tsamples\tsymbol",
      ...ranked(totals[kind])
        .slice(0, 30)
        .map(([name, count]) => `${percent(count, samples.length)}\t${count}\t${name}`),
    ]),
    "",
  ].join("\n");
}

export function runtimePatterns(samples: IStackSample[]): string[] {
  return ranked(counts(samples).runtime)
    .slice(0, 5)
    .map(([name]) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

export function formatCallers(samples: IStackSample[], patterns: string[]): string {
  return patterns
    .flatMap((pattern) => {
      const regex = new RegExp(pattern);
      const matching = samples.filter((sample) => regex.test(sample.frames[0] ?? ""));
      const attributed = new Map<string, { count: number; callees: Map<string, number> }>();
      for (const sample of matching) {
        const index = sample.frames.findIndex((frame) => tsFrame(frame));
        const ts = index < 0 ? undefined : tsFrame(sample.frames[index] ?? "");
        const below =
          index > 0 ? sample.frames[index - 1] : index === 0 ? "[TS leaf]" : sample.frames[0];
        const key = ts?.function ?? "[no TS frame]";
        const entry = attributed.get(key) ?? { count: 0, callees: new Map<string, number>() };
        entry.count++;
        const callee = below ?? "[no callchain]";
        entry.callees.set(callee, (entry.callees.get(callee) ?? 0) + 1);
        attributed.set(key, entry);
      }
      return [
        `${pattern}: ${matching.length}/${samples.length} samples (${percent(matching.length, samples.length)} total)`,
        "% total\t% matched\tsamples\tnearest TS frame\tdirect callee",
        ...[...attributed]
          .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
          .slice(0, 15)
          .map(([name, entry]) => {
            const [callee, count] = ranked(entry.callees)[0] ?? ["[no callchain]", 0];
            const share = entry.callees.size > 1 ? ` (dominant ${count}/${entry.count})` : "";
            return `${percent(entry.count, samples.length)}\t${percent(entry.count, matching.length)}\t${entry.count}\t${name}\t<- ${callee}${share}`;
          }),
        "",
      ];
    })
    .join("\n");
}

export function formatDiff(a: IStackSample[], b: IStackSample[]): string {
  const left = counts(a);
  const right = counts(b);
  return [
    `Samples: A=${a.length}; B=${b.length}; delta = B - A`,
    ...(["functions", "runtime"] as const).flatMap((kind) => {
      const rows = [...new Set([...left[kind].keys(), ...right[kind].keys()])]
        .map((name) => {
          const x = ((left[kind].get(name) ?? 0) * 100) / a.length;
          const y = ((right[kind].get(name) ?? 0) * 100) / b.length;
          return { name, x, y, delta: y - x };
        })
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.name.localeCompare(y.name));
      return [
        `\n${kind === "functions" ? "TS functions inclusive" : "Runtime/native self-time"}`,
        "A\tB\tdelta\tsymbol",
        ...rows.map(
          (row) =>
            `${row.x.toFixed(2)}%\t${row.y.toFixed(2)}%\t${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(2)}pp\t${row.name}`,
        ),
      ];
    }),
    "",
  ].join("\n");
}

export function parseProfileArgs(argv: readonly string[]): IProfileArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!["--window", "--split-ms", "--buildid-dir"].includes(arg))
      throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--") || options.has(arg)) throw new Error(`Invalid ${arg}`);
    options.set(arg, value);
  }
  const command = positionals.shift();
  if (command !== "callers" && command !== "top" && command !== "diff")
    throw new Error(
      "Usage: perry:profile callers <perf.data> <symbol-regex>... | top <perf.data> | diff <a.data> <b.data> [--window startup|steady|all] [--split-ms n] [--buildid-dir dir]",
    );
  const files = positionals.splice(0, command === "diff" ? 2 : 1);
  if (
    files.length !== (command === "diff" ? 2 : 1) ||
    (command === "callers" ? !positionals.length : positionals.length > 0)
  )
    throw new Error(`Invalid arguments for ${command}`);
  for (const pattern of positionals) new RegExp(pattern);
  const window = options.get("--window") ?? "all";
  if (window !== "all" && window !== "startup" && window !== "steady")
    throw new Error("Invalid --window");
  const splitMs = options.has("--split-ms") ? Number(options.get("--split-ms")) : undefined;
  if (splitMs !== undefined && (!Number.isFinite(splitMs) || splitMs < 0))
    throw new Error("Invalid --split-ms");
  return {
    command,
    files,
    patterns: positionals,
    window,
    splitMs,
    buildidDir: options.get("--buildid-dir"),
  };
}

export async function loadProfile(
  data: string,
  buildidDir?: string,
  readScript?: (args: string[]) => Promise<string>,
): Promise<IStackSample[]> {
  const metadata = await stat(data);
  const identity = JSON.stringify({
    version: 2,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    buildidDir: buildidDir ?? "",
  });
  const cache = `${data}.folded`;
  try {
    const [header, ...lines] = (await readFile(cache, "utf8")).trimEnd().split("\n");
    if (header === `# ${identity}`) {
      const samples = lines.map((line) => {
        const [time, stack] = line.split("\t");
        if (!time || !stack?.endsWith(" 1") || !Number.isFinite(Number(time)))
          throw new Error("Invalid folded cache");
        return {
          time: Number(time),
          frames: stack.slice(0, -2).split(";").reverse().map(decodeURIComponent),
        };
      });
      if (samples.length && samples.every((sample) => sample.frames.every(Boolean))) return samples;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const args = [
    "-n",
    "19",
    "perf",
    "script",
    "--demangle",
    "--no-inline",
    "-F",
    "time,ip,sym,dso",
    "-i",
    data,
  ];
  if (buildidDir) args.splice(3, 0, "--buildid-dir", buildidDir);
  const output = readScript
    ? await readScript(args)
    : await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "nice",
          args,
          { timeout: 540_000, maxBuffer: 256 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error)
              reject(new Error(`perf script failed: ${error.message}\n${stderr.slice(-2000)}`));
            else resolve(stdout);
          },
        );
        child.stdin?.end();
      });
  const samples = parsePerfScript(output);
  const after = await stat(data);
  if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs)
    throw new Error("perf.data changed while reading");
  const folded = samples
    .map(
      (sample) => `${sample.time}\t${sample.frames.map(encodeURIComponent).reverse().join(";")} 1`,
    )
    .join("\n");
  const temporary = `${cache}.${process.pid}.tmp`;
  await writeFile(temporary, `# ${identity}\n${folded}\n`);
  await rename(temporary, cache);
  return samples;
}

export async function profileWindow(
  data: string,
  args: Pick<IProfileArgs, "window" | "splitMs" | "buildidDir">,
) {
  const samples = await loadProfile(data, args.buildidDir);
  if (args.window === "all" || args.splitMs !== undefined)
    return selectWindow(samples, args.window, args.splitMs);
  const name = path.basename(data, ".data");
  const consoleFile = path.join(path.dirname(data), `${name}-perf/console.json`);
  const log = await readFile(consoleFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return readFile(path.join(path.dirname(data), `${name}-perf.log`), "utf8").catch(
      (failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return "";
      },
    );
  });
  return selectWindow(samples, args.window, args.splitMs, log);
}

async function main(argv: string[]) {
  const args = parseProfileArgs(argv);
  // Sequential: the shared host must never run two perf readers together.
  const a = await profileWindow(args.files[0] ?? "", args);
  let output: string;
  if (args.command === "diff") {
    const b = await profileWindow(args.files[1] ?? "", args);
    output = `A window: ${a.description}\nB window: ${b.description}\n${formatDiff(a.samples, b.samples)}`;
  } else {
    output = `Window: ${a.description}\n${args.command === "top" ? formatTop(a.samples) : formatCallers(a.samples, args.patterns)}`;
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
