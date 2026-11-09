/**
 * PRD-860 load benchmark: how long a built web game takes from navigation to
 * `__TN_STARTUP_READY__`, on a first visit (empty browser profile) and on repeat visits
 * (the same profile, browser relaunched), served the way a production host serves it.
 *
 *   pnpm bench:load --prepare <out> [--kit collectathon]   scaffold from local packages, build
 *   pnpm bench:load --dist <out>/dist [--runs 5] [--network 20000:40] [--json]
 *     [--cpu-profile <file.cpuprofile>]   the first repeat visit's main-thread CPU profile
 *
 * The server sends the build's `.br` copies with `Content-Encoding: br` and applies the
 * `_headers` file, so the result reads the bytes and cache rules a player gets, not a dev server's.
 * A software WebGPU adapter fails the run: its timings describe a CPU rasteriser.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { WEBGPU_BROWSER_ARGS } from "../packages/playtest/src/runner/browser.js";

const READY = "globalThis.__TN_STARTUP_READY__ === true";
const STAGE_MARKERS = ["TN_STATIC_COLLIDERS", "TN_STARTUP_WARMUP", "TN_AUTO_EXPOSURE"] as const;

export interface ILoadRun {
  readonly arm: "first" | "repeat";
  readonly readyMs: number;
  readonly requests: number;
  readonly wireBytes: number;
  readonly stages: Readonly<Record<string, number>>;
}

interface IArgs {
  readonly prepare?: string;
  readonly kit: string;
  readonly dist?: string;
  readonly runs: number;
  readonly network?: { readonly kbps: number; readonly latencyMs: number };
  readonly json: boolean;
  readonly cpuProfile?: string;
}

function parseArgs(argv: readonly string[]): IArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new Error(`TN_LOAD_BENCH_ARGS: ${name} needs a value.`);
    return next;
  };
  const runs = Number(value("--runs") ?? 5);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("TN_LOAD_BENCH_ARGS: --runs must be a positive integer.");
  const net = value("--network");
  let network: IArgs["network"];
  if (net !== undefined) {
    const [kbps = Number.NaN, latencyMs = Number.NaN] = net.split(":").map(Number);
    if (!(kbps > 0) || !(latencyMs >= 0))
      throw new Error("TN_LOAD_BENCH_ARGS: --network is <kbps>:<latencyMs>, for example 20000:40.");
    network = { kbps, latencyMs };
  }
  const args = {
    cpuProfile: value("--cpu-profile"),
    dist: value("--dist"),
    json: argv.includes("--json"),
    kit: value("--kit") ?? "collectathon",
    network,
    prepare: value("--prepare"),
    runs,
  };
  if ((args.dist === undefined) === (args.prepare === undefined))
    throw new Error("TN_LOAD_BENCH_ARGS: pass exactly one of --prepare <out> or --dist <dir>.");
  return args;
}

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/** Netlify/Cloudflare `_headers`: a path line, then indented `Name: value` lines. `*` matches any run. */
export function parseHeadersFile(
  text: string,
): Array<{ pattern: RegExp; headers: [string, string][] }> {
  const rules: Array<{ pattern: RegExp; headers: [string, string][] }> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const source = line
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      rules.push({ headers: [], pattern: new RegExp(`^${source}$`) });
      continue;
    }
    const rule = rules.at(-1);
    const colon = line.indexOf(":");
    if (rule === undefined || colon === -1)
      throw new Error(`TN_LOAD_BENCH_HEADERS: cannot read _headers line "${line.trim()}".`);
    rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function serve(dist: string): Promise<{ url: string; close: () => Promise<void> }> {
  const headersFile = path.join(dist, "_headers");
  const rules = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, "utf8")) : [];
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const relative = urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
    const file = path.join(dist, relative);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    };
    for (const rule of rules)
      if (rule.pattern.test(urlPath)) for (const [k, v] of rule.headers) headers[k] = v;
    // A production host revalidates a file with no cache rule; ETag lets the browser get a 304.
    const stat = statSync(file);
    const etag = `"${stat.size}-${stat.mtimeMs}"`;
    headers.ETag = etag;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers).end();
      return;
    }
    const brotli = `${file}.br`;
    const acceptsBr = String(request.headers["accept-encoding"] ?? "").includes("br");
    const body = acceptsBr && existsSync(brotli) ? readFileSync(brotli) : readFileSync(file);
    if (acceptsBr && existsSync(brotli)) headers["Content-Encoding"] = "br";
    headers.Vary = "Accept-Encoding";
    response.writeHead(200, headers).end(body);
  };
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
        url: `http://127.0.0.1:${port}/`,
      });
    });
  });
}

async function visit(
  url: string,
  profile: string,
  arm: ILoadRun["arm"],
  network: IArgs["network"],
  cpuProfile?: string,
  marksFile?: string,
): Promise<ILoadRun & { adapter: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    // TN_LOAD_BENCH_CHROME_ARGS adds browser switches for one experiment, e.g. a Dawn toggle.
    args: [
      ...WEBGPU_BROWSER_ARGS,
      ...(process.env.TN_LOAD_BENCH_CHROME_ARGS?.split(" ").filter(Boolean) ?? []),
    ],
    headless: false,
    viewport: { height: 720, width: 1280 },
  });
  // TN_LOAD_BENCH_INIT=<file.js> runs a probe before the page's own scripts (for example, one that
  // logs a hash of every shader module), so a stage can be attributed without rebuilding the game.
  if (process.env.TN_LOAD_BENCH_INIT)
    await context.addInitScript({ path: process.env.TN_LOAD_BENCH_INIT });
  try {
    const page = await context.newPage();
    const stages: Record<string, number> = {};
    let started = 0;
    const marks: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("TN_")) marks.push(`${Date.now() - started} ${text.slice(0, 240)}`);
      for (const marker of STAGE_MARKERS)
        if (text.startsWith(marker) && stages[marker] === undefined)
          stages[marker] = Date.now() - started;
    });
    let requests = 0;
    let wireBytes = 0;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.loadingFinished", (event) => {
      requests += 1;
      wireBytes += event.encodedDataLength;
    });
    if (network !== undefined)
      await cdp.send("Network.emulateNetworkConditions", {
        downloadThroughput: (network.kbps * 1000) / 8,
        latency: network.latencyMs,
        offline: false,
        uploadThroughput: (network.kbps * 1000) / 8,
      });
    if (cpuProfile !== undefined) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
      // TN_LOAD_BENCH_TRACE=1: a whole-browser trace too, for the GPU process the CPU profile cannot see.
      if (process.env.TN_LOAD_BENCH_TRACE === "1")
        await cdp.send("Tracing.start", {
          transferMode: "ReturnAsStream",
          traceConfig: {
            includedCategories: [
              "toplevel",
              "gpu",
              "dawn",
              "disabled-by-default-gpu.dawn",
              "gpu.capture",
              "v8.execute",
              "blink",
            ],
          },
        });
    }
    started = Date.now();
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(READY, null, { polling: 16, timeout: 180_000 });
    // TN_LOAD_BENCH_SHOTS=<dir>: the ready frame of every visit, for a visual judge (PRD-860 AC-4).
    if (marksFile !== undefined && process.env.TN_LOAD_BENCH_SHOTS)
      await page.screenshot({
        path: path.join(process.env.TN_LOAD_BENCH_SHOTS, `${path.basename(marksFile, ".txt")}.png`),
      });
    // TN_LOAD_BENCH_RESOURCES=1: each request's start and end since navigation, as `TN_RESOURCE` marks.
    if (process.env.TN_LOAD_BENCH_RESOURCES === "1")
      for (const line of await page.evaluate(() =>
        performance.getEntriesByType("resource").map((resource) => {
          const entry = resource as PerformanceResourceTiming;
          return `${Math.round(entry.responseEnd)} TN_RESOURCE ${Math.round(entry.startTime)}-${Math.round(entry.responseEnd)} ${entry.encodedBodySize} ${entry.name.split("/").pop()}`;
        }),
      ))
        marks.push(line);
    if (cpuProfile !== undefined) {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(cpuProfile, JSON.stringify(profile));
      // Every TN_ line with its time since navigation, beside the profile it explains.
      await writeFile(`${cpuProfile}.marks.txt`, `${marks.join("\n")}\n`);
      if (process.env.TN_LOAD_BENCH_TRACE === "1") {
        const done = new Promise<{ stream?: string }>((resolve) =>
          cdp.once("Tracing.tracingComplete", resolve),
        );
        await cdp.send("Tracing.end");
        const { stream } = await done;
        const chunks: string[] = [];
        for (let eof = false; stream !== undefined && !eof; ) {
          const chunk = await cdp.send("IO.read", { handle: stream });
          chunks.push(chunk.data);
          eof = chunk.eof;
        }
        await writeFile(`${cpuProfile}.trace.json`, chunks.join(""));
      }
    }
    if (marksFile !== undefined) await writeFile(marksFile, `${marks.join("\n")}\n`);
    const readyMs = await page.evaluate(() => Math.round(performance.now()));
    const adapter = await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      const found = (await gpu?.requestAdapter()) as
        | { info?: { vendor?: string; architecture?: string }; isFallbackAdapter?: boolean }
        | null
        | undefined;
      if (found === null || found === undefined) return "none";
      return `${found.info?.vendor ?? "?"}/${found.info?.architecture ?? "?"}${found.isFallbackAdapter === true ? "/fallback" : ""}`;
    });
    return { adapter, arm, readyMs, requests, stages, wireBytes };
  } finally {
    await context.close();
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("TN_LOAD_BENCH_EMPTY: no run to take a median of.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const at = (index: number): number => sorted[index] as number;
  return sorted.length % 2 === 1 ? at(middle) : Math.round((at(middle - 1) + at(middle)) / 2);
}

export async function measure(args: IArgs & { dist: string }) {
  const dist = path.resolve(args.dist);
  if (!existsSync(path.join(dist, "index.html")))
    throw new Error(`TN_LOAD_BENCH_DIST: ${dist} has no index.html; build the game first.`);
  const server = await serve(dist);
  const runs: Array<ILoadRun & { adapter: string }> = [];
  try {
    for (let cycle = 0; cycle < args.runs; cycle += 1) {
      const profile = await mkdtemp(path.join(tmpdir(), "tn-load-bench-"));
      try {
        // TN_LOAD_BENCH_MARKS=<dir> keeps every visit's TN_ lines, to compare one stage across visits.
        const marks = (n: number) =>
          process.env.TN_LOAD_BENCH_MARKS &&
          path.join(process.env.TN_LOAD_BENCH_MARKS, `${cycle}-${n}.txt`);
        const profileOut = cycle === 0 ? args.cpuProfile : undefined;
        // TN_LOAD_BENCH_PROFILE=first profiles the first visit instead of the first repeat.
        const first = process.env.TN_LOAD_BENCH_PROFILE === "first";
        runs.push(
          await visit(
            server.url,
            profile,
            "first",
            args.network,
            first ? profileOut : undefined,
            marks(0),
          ),
        );
        runs.push(
          await visit(
            server.url,
            profile,
            "repeat",
            args.network,
            first ? undefined : profileOut,
            marks(1),
          ),
        );
        runs.push(await visit(server.url, profile, "repeat", args.network, undefined, marks(2)));
      } finally {
        await rm(profile, { force: true, recursive: true });
      }
    }
  } finally {
    await server.close();
  }
  const adapters = [...new Set(runs.map((run) => run.adapter))];
  if (adapters.some((adapter) => adapter === "none" || /fallback|swiftshader|cpu/i.test(adapter)))
    throw new Error(
      `TN_LOAD_BENCH_ADAPTER: a run had no hardware WebGPU adapter (${adapters.join(", ")}).`,
    );
  const summary = (arm: ILoadRun["arm"]) => {
    const own = runs.filter((run) => run.arm === arm);
    const stage = (marker: string) => {
      const seen = own
        .map((run) => run.stages[marker])
        .filter((ms): ms is number => ms !== undefined);
      return seen.length === own.length ? median(seen) : undefined;
    };
    return {
      medianReadyMs: median(own.map((run) => run.readyMs)),
      minReadyMs: Math.min(...own.map((run) => run.readyMs)),
      maxReadyMs: Math.max(...own.map((run) => run.readyMs)),
      medianRequests: median(own.map((run) => run.requests)),
      medianWireKB: Math.round(median(own.map((run) => run.wireBytes)) / 1024),
      runs: own.length,
      stagesMs: Object.fromEntries(STAGE_MARKERS.map((marker) => [marker, stage(marker)])),
    };
  };
  return {
    adapter: adapters.join(", "),
    first: summary("first"),
    network: args.network ?? null,
    repeat: summary("repeat"),
    runs,
  };
}

function run(command: string, commandArgs: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${commandArgs.join(" ")} exited ${code}.`)),
    );
  });
}

async function prepare(out: string, kit: string): Promise<string> {
  const { createProject } = await import("../packages/create-threenative/src/index.js");
  const { packageLocalFramework } = await import("./visual-gate.js");
  const root = path.resolve(out);
  await mkdir(root, { recursive: true });
  const packageSources = await packageLocalFramework(root);
  const project = await createProject(
    { install: true, packageSources, target: kit, template: kit },
    root,
  );
  await run("pnpm", ["build:web"], project.target);
  return path.join(project.target, "dist");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.prepare !== undefined) {
    process.stdout.write(`TN_LOAD_BENCH_DIST ${await prepare(args.prepare, args.kit)}\n`);
    return;
  }
  const result = await measure({ ...args, dist: args.dist as string });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const line = (name: string, arm: typeof result.first) =>
    `${name}: median ${arm.medianReadyMs} ms (min ${arm.minReadyMs}, max ${arm.maxReadyMs}, n=${arm.runs}), ` +
    `${arm.medianRequests} requests, ${arm.medianWireKB} KB on the wire, stages ${JSON.stringify(arm.stagesMs)}`;
  process.stdout.write(
    `TN_LOAD_BENCH adapter=${result.adapter} network=${JSON.stringify(result.network)}\n` +
      `${line("first visit", result.first)}\n${line("repeat visit", result.repeat)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
