// The Dashboard's Playtests view (PRD-923): lists `playtests/**/*.playtest.json`, runs one at a time
// with the project's own `@threenative/playtest` CLI against the dev server already running (never a
// second Vite), streams its output, and serves the run's PNG and JSON artifacts from inside the
// run's own folder only.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export interface IScenarioRow {
  readonly path: string;
  readonly name: string;
  readonly assertions: number;
  readonly last?: { readonly run: string; readonly pass: boolean; readonly at: string };
}

export interface IRunResult {
  readonly pass: boolean;
  readonly exitCode: number | null;
  readonly assertions: readonly { id: string; pass: boolean; details?: unknown }[];
  readonly diagnostics: readonly { code?: string; message?: string; severity?: string }[];
  readonly images: readonly string[];
  readonly cancelled?: boolean;
}

export interface IRunState {
  readonly id: string;
  readonly scenario: string;
  readonly startedAt: string;
  status: "running" | "passed" | "failed" | "cancelled" | "error";
  lines: string[];
  result?: IRunResult;
}

type Listener = (event: { type: "line"; line: string } | { type: "done"; run: IRunState }) => void;

const SCENARIO = /\.playtest\.json$/u;
const MAX_LINES = 2000;

/** Every scenario under `<root>/playtests/`, three folders deep at most. */
export async function listScenarios(root: string, last: ReadonlyMap<string, IRunState> = new Map()): Promise<IScenarioRow[]> {
  const base = path.join(root, "playtests");
  const out: IScenarioRow[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (entry.isFile() && SCENARIO.test(entry.name)) {
        const relative = path.relative(root, full).replaceAll("\\", "/");
        let assertions = 0;
        let name = entry.name.replace(SCENARIO, "");
        try {
          const json = JSON.parse(await readFile(full, "utf8")) as { name?: unknown; assertions?: unknown };
          if (Array.isArray(json.assertions)) assertions = json.assertions.length;
          if (typeof json.name === "string") name = json.name;
        } catch {
          // An unreadable scenario still lists; running it reports why.
        }
        const run = last.get(relative);
        out.push({
          path: relative,
          name,
          assertions,
          ...(run && run.status !== "running"
            ? { last: { run: run.id, pass: run.status === "passed", at: run.startedAt } }
            : {}),
        });
      }
    }
  };
  await walk(base, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A scenario path from a request, checked to be a scenario file inside `<root>/playtests/`. */
export function scenarioPath(root: string, requested: string): string {
  const file = path.resolve(root, requested);
  const base = path.resolve(root, "playtests");
  if (!file.startsWith(`${base}${path.sep}`) || !SCENARIO.test(file) || !existsSync(file))
    throw new Error(`not a playtest scenario under playtests/: ${requested}`);
  return file;
}

/** The project's own playtest CLI, as its `node_modules` resolves it. */
export function playtestCli(root: string): string {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const cli = path.join(path.dirname(require.resolve("@threenative/playtest/package.json")), "dist/runner/cli.js");
    if (existsSync(cli)) return cli;
  } catch {
    // Reported below.
  }
  throw new Error("TN_PLAYTEST_RUNNER_MISSING: install @threenative/playtest (pnpm add -D @threenative/playtest).");
}

export class PlaytestRunner {
  #child: ChildProcess | undefined;
  #current: IRunState | undefined;
  readonly #listeners = new Set<Listener>();
  /** The latest run per scenario, so the list can show it. */
  readonly last = new Map<string, IRunState>();
  readonly runs = new Map<string, IRunState>();
  #counter = 0;

  constructor(
    readonly root: string,
    readonly options: { readonly cli?: () => string; readonly node?: string } = {},
  ) {}

  get busy(): boolean {
    return this.#current?.status === "running";
  }

  get current(): IRunState | undefined {
    return this.#current;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(line: string): void {
    const run = this.#current;
    if (!run) return;
    run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    for (const listener of this.#listeners) listener({ type: "line", line });
  }

  /** The run folder: inside the project's Vite cache, one per run, never shared. */
  artifactDir(id: string): string {
    return path.join(this.root, "node_modules/.cache/threenative-dashboard/playtests", id);
  }

  /** Starts one run. Throws `busy` while another runs (the route answers 409). */
  start(requested: string, url: string, options: { readonly check?: boolean } = {}): IRunState {
    if (this.busy) throw Object.assign(new Error("a playtest is already running"), { busy: true });
    const scenario = scenarioPath(this.root, requested);
    const cli = (this.options.cli ?? (() => playtestCli(this.root)))();
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/u.test(url))
      throw new Error(`the playtest runs against this dev server's loopback URL, got ${url}`);
    this.#counter += 1;
    const id = `${Date.now().toString(36)}-${this.#counter}`;
    const relative = path.relative(this.root, scenario).replaceAll("\\", "/");
    const run: IRunState = { id, scenario: relative, startedAt: new Date().toISOString(), status: "running", lines: [] };
    this.#current = run;
    this.runs.set(id, run);
    const args = [
      cli,
      scenario,
      "--url",
      url,
      "--browser-recipe",
      "webgpu",
      "--artifacts",
      this.artifactDir(id),
      ...(options.check ? [] : ["--skip-check"]),
    ];
    this.#emit(`$ threenative-playtest ${relative} --url ${url} --browser-recipe webgpu${options.check ? "" : " --skip-check"}`);
    const child = spawn(this.options.node ?? process.execPath, args, {
      cwd: this.root,
      // Its own process group, so Cancel stops the browser it launched as well.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    this.#child = child;
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let partial = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = partial + chunk.toString();
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.#emit(line);
    });
    child.on("error", (error) => {
      this.#emit(`runner failed to start: ${error.message}`);
    });
    child.on("close", (code) => {
      if (partial.trim()) this.#emit(partial);
      void this.#finish(run, code, stdout);
    });
    return run;
  }

  async #finish(run: IRunState, code: number | null, stdout: string): Promise<void> {
    const cancelled = run.status === "cancelled";
    let report: { pass?: boolean; assertionResults?: IRunResult["assertions"]; diagnostics?: IRunResult["diagnostics"]; reports?: unknown[] } = {};
    try {
      report = JSON.parse(stdout.slice(stdout.indexOf("{")));
    } catch {
      if (stdout.trim()) this.#emit(stdout.trim().slice(0, 2000));
    }
    const reports = (Array.isArray(report.reports) ? report.reports : [report]) as (typeof report)[];
    const images = await this.#images(run.id);
    run.result = {
      pass: report.pass === true && code === 0,
      exitCode: code,
      assertions: reports.flatMap((r) => r.assertionResults ?? []),
      diagnostics: reports.flatMap((r) => r.diagnostics ?? []),
      images,
      ...(cancelled ? { cancelled: true } : {}),
    };
    run.status = cancelled ? "cancelled" : run.result.pass ? "passed" : code === 2 ? "error" : "failed";
    this.#emit(`exit ${code ?? "signal"} · ${run.status}`);
    this.last.set(run.scenario, run);
    this.#child = undefined;
    for (const listener of this.#listeners) listener({ type: "done", run });
  }

  async #images(id: string): Promise<string[]> {
    const dir = this.artifactDir(id);
    const out: string[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (!existsSync(folder)) return;
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && depth < 2) await walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".png")) out.push(path.relative(dir, full).replaceAll("\\", "/"));
      }
    };
    await walk(dir, 0);
    return out.sort();
  }

  /** Stops the running playtest and the browser it launched. */
  cancel(): boolean {
    const child = this.#child;
    if (!child || !this.busy || !this.#current) return false;
    this.#current.status = "cancelled";
    this.#emit("cancel requested");
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
    }, 5000).unref();
    return true;
  }

  /** An artifact of one run: a PNG or JSON inside that run's folder, or undefined. */
  artifact(id: string, file: string): string | undefined {
    if (!/^[\w.-]+$/u.test(id) || !this.runs.has(id)) return undefined;
    const dir = path.resolve(this.artifactDir(id));
    const full = path.resolve(dir, file);
    if (!full.startsWith(`${dir}${path.sep}`) || !/\.(png|json)$/u.test(full) || !existsSync(full)) return undefined;
    return full;
  }
}
