// `/__dashboard/api/*` (PRD-918, PRD-923): the Dev Dashboard's dev-server routes. Mounted by the
// Asset Library plugin, which is `apply: "serve"`, so none of this reaches a build.
import { createReadStream, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { ConfigEditError, patchConfig, readConfigView } from "./config-editor.js";
import { CONFIG_FIELDS, CRASH_REPORTS_PATH } from "./config-fields.js";
import { projectHealth } from "./health.js";
import { PlaytestRunner, listScenarios } from "./playtest-runner.js";
import { PROCEDURAL_ENDPOINT, procedurallyExcluded, shareProcedural } from "./procedural-share.js";
import { MODEL_FAMILIES } from "./scrub-trace.js";
import { prefsFile, readPrefs, writePrefs } from "./telemetry-prefs.js";
import { TRACE_ENDPOINT, discoverTraces, previewTrace, shareTraces } from "./trace-collector.js";

export interface IDashboardApi {
  /** Handles `rest` (the path after `/__dashboard/api/`); false when no route matched. */
  handle(rest: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
}

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
  return true;
};

const MAX_BODY = 64 * 1024;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body over 64 KB"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8") || "{}";
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw Object.assign(new Error("expected a JSON object"), { status: 400 });
  return parsed as Record<string, unknown>;
}

/**
 * A write must come from this dev server's own pages: JSON (which a cross-site form cannot send
 * without a preflight) and, when the browser names one, a same-origin `Origin`. Otherwise any site
 * the developer visits could rewrite the config or start an upload.
 */
function sameOrigin(req: IncomingMessage): string | undefined {
  if ((req.headers["content-type"] ?? "").split(";")[0]?.trim() !== "application/json")
    return "writes need content-type: application/json";
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return `cross-site request refused (${site})`;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return "malformed Origin";
    }
    if (host !== req.headers.host) return `cross-origin request refused (${origin})`;
  }
  return undefined;
}

/** Saved bakes under `assets/procedural/`, each with why it can or cannot be shared. */
async function procedurals(root: string) {
  const base = path.join(root, "assets/procedural");
  const out: { path: string; excluded?: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".glb")) {
        const relative = path.relative(root, full).replaceAll("\\", "/");
        const excluded = procedurallyExcluded(relative);
        out.push({ path: relative, ...(excluded ? { excluded } : {}) });
      }
    }
  };
  await walk(base, 0);
  return out;
}

export function createDashboardApi(options: {
  readonly root: string;
  /** The dev server's loopback URL, once it listens. */
  readonly url: () => string | undefined;
  readonly engineVersion?: string;
}): IDashboardApi {
  const { root } = options;
  const runner = new PlaytestRunner(root);
  let health: Awaited<ReturnType<typeof projectHealth>> | undefined;

  const telemetryView = async () => {
    const view = await readConfigView(root);
    return {
      crashReports: view.resolved[CRASH_REPORTS_PATH] !== false,
      crashReportsAuthored: CRASH_REPORTS_PATH in view.authored,
      ...(await readPrefs()),
      prefsFile: prefsFile(),
      models: MODEL_FAMILIES,
      endpoints: { procedurals: PROCEDURAL_ENDPOINT, traces: TRACE_ENDPOINT },
    };
  };

  const routes: Record<
    string,
    (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>
  > = {
    "GET config": async () => ({ fields: CONFIG_FIELDS, ...(await readConfigView(root)) }),
    "PATCH config": async (req, res) => {
      const changes = (await body(req)).changes;
      if (typeof changes !== "object" || changes === null)
        return send(res, 400, { error: "expected { changes }" });
      const { view, engineChanged } = await patchConfig(root, changes as Record<string, unknown>);
      return { fields: CONFIG_FIELDS, ...view, restarting: engineChanged };
    },
    "GET telemetry": telemetryView,
    "PATCH telemetry": async (req) => {
      const { crashReports, ...prefs } = await body(req);
      if (crashReports !== undefined) {
        if (typeof crashReports !== "boolean")
          throw Object.assign(new Error("crashReports: expected a boolean"), { status: 400 });
        // Back to the default is "remove the key", so an opted-in project carries no telemetry line.
        await patchConfig(root, { [CRASH_REPORTS_PATH]: crashReports ? null : false });
      }
      if (Object.keys(prefs).length > 0)
        await writePrefs(prefs).catch((error: Error) => {
          throw Object.assign(error, { status: 400 });
        });
      return telemetryView();
    },
    "GET telemetry/traces": async () => ({ traces: await discoverTraces(root) }),
    "POST telemetry/traces/preview": async (req, res) => {
      const { id } = await body(req);
      const candidate = (await discoverTraces(root)).find((trace) => trace.id === id);
      if (!candidate) return send(res, 404, { error: `no session ${String(id)}` });
      return previewTrace(candidate);
    },
    "POST telemetry/traces/share": async (_req, res) => {
      if (!(await readPrefs()).shareSessionTraces)
        return send(res, 409, { error: "Share session traces is off on this machine." });
      const engineVersion = options.engineVersion ?? installedCoreVersion(root);
      return shareTraces(root, engineVersion ? { engineVersion } : {});
    },
    "GET telemetry/procedurals": async () => ({ files: await procedurals(root) }),
    "POST telemetry/procedurals/share": async (req) => {
      const { path: file } = await body(req);
      if (typeof file !== "string")
        throw Object.assign(new Error("expected { path }"), { status: 400 });
      return shareProcedural(root, { path: file, source: "manual" });
    },
    "GET health": async (_req, _res, url) => {
      if (!health || url.searchParams.get("refresh") === "1") health = await projectHealth(root);
      return health;
    },
    "GET playtests": async () => ({
      scenarios: await listScenarios(root, runner.last),
      running: runner.busy ? runner.current : undefined,
    }),
    "POST playtests/run": async (req, res) => {
      const { path: scenario, check } = await body(req);
      const url = options.url();
      if (!url) return send(res, 503, { error: "the dev server is not listening yet" });
      if (runner.busy)
        return send(res, 409, {
          error: "a playtest is already running",
          running: runner.current?.id,
        });
      const run = runner.start(String(scenario ?? ""), url, { check: check === true });
      return { id: run.id, scenario: run.scenario };
    },
    "POST playtests/cancel": async () => ({ cancelled: runner.cancel() }),
    "GET playtests/stream": async (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const write = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const run = runner.current;
      if (run) {
        write("start", { id: run.id, scenario: run.scenario });
        for (const line of run.lines) write("line", line);
        if (run.status !== "running") write("done", run);
      }
      const off = runner.subscribe((event) =>
        event.type === "line" ? write("line", event.line) : write("done", event.run),
      );
      req.on("close", off);
      return true;
    },
    "GET playtests/artifact": async (_req, res, url) => {
      const file = runner.artifact(
        url.searchParams.get("run") ?? "",
        url.searchParams.get("file") ?? "",
      );
      if (!file) return send(res, 404, { error: "no such artifact in that run" });
      res.setHeader("content-type", file.endsWith(".png") ? "image/png" : "application/json");
      res.setHeader("cache-control", "no-store");
      createReadStream(file)
        .on("error", () => res.destroy())
        .pipe(res);
      return true;
    },
  };

  return {
    async handle(rest, url, req, res) {
      const route = routes[`${req.method ?? "GET"} ${rest}`];
      if (!route) return false;
      if (req.method !== "GET") {
        const refused = sameOrigin(req);
        if (refused) return send(res, 403, { error: refused });
      }
      try {
        const result = await route(req, res, url);
        if (result !== true) send(res, 200, result);
      } catch (error) {
        const status =
          (error as { status?: number }).status ?? (error instanceof ConfigEditError ? 400 : 500);
        send(res, status, {
          error: (error as Error).message,
          ...(error instanceof ConfigEditError ? { fields: error.fields } : {}),
        });
      }
      return true;
    },
    close() {
      runner.cancel();
    },
  };
}

/** The project's installed `@threenative/core` version: the engine a shared trace was made with. */
function installedCoreVersion(root: string): string | undefined {
  try {
    // Resolved like Node would, so a hoisted or workspace install is found too.
    const file = createRequire(path.join(root, "package.json")).resolve(
      "@threenative/core/package.json",
    );
    const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
