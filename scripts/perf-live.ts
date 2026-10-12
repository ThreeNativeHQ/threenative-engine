// `pnpm perf:live` — leave the tab open; every bench:engines report that lands under the watched
// roots shows up within seconds. It reads the reports the benches already write (no new timing,
// no hook in the benches), validates them with the bench's own parser, and plots p50 per workload.
// ponytail: polls every 2 s and rescans the roots; add fs.watch only if the roots grow past ~10k files.
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseRunReport, summarize } from "./engine-load-test/report.js";

export interface IRow {
  arm: string;
  engine: string;
  file: string;
  mode: string;
  objects: number;
  p50: number;
  p95: number;
  /** Run time: the date in the file name when it has one (copied pilots share one mtime), else mtime. */
  t: number;
  /** mtime, to order runs that share a date. */
  m: number;
}

const args = process.argv.slice(2);
const flag = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
const port = Number(flag("--port")[0] ?? 8765);
const roots = flag("--root").length
  ? flag("--root")
  : [path.join(process.cwd(), "artifacts", "engine-load-test")];

const cache = new Map<string, { mtime: number; rows: IRow[] }>();

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith(".json")) yield full;
  }
}

export function rowsOf(report: unknown, file: string, mtime: number): IRow[] {
  const day = /(\d{4}-\d{2}-\d{2})/u.exec(file)?.[1];
  const t = day ? Date.parse(`${day}T12:00:00Z`) : mtime;
  const r = parseRunReport(report);
  return summarize(r).map((s) => ({
    arm: r.arm,
    engine: r.engine.name,
    file,
    mode: s.mode,
    objects: s.objectCount,
    p50: s.p50,
    p95: s.p95,
    t,
    m: mtime,
  }));
}

async function allRows(): Promise<IRow[]> {
  const rows: IRow[] = [];
  for (const root of roots) {
    for await (const file of walk(root)) {
      const mtime = (await stat(file)).mtimeMs;
      let hit = cache.get(file);
      if (hit?.mtime !== mtime) {
        // Not every json under the roots is a run report; those parse-fail once and stay empty.
        const rows = await readFile(file, "utf8")
          .then((text) => rowsOf(JSON.parse(text), path.relative(root, file), mtime))
          .catch(() => []);
        hit = { mtime, rows };
        cache.set(file, hit);
      }
      rows.push(...hit.rows);
    }
  }
  return rows.sort((a, b) => a.t - b.t || a.m - b.m || a.file.localeCompare(b.file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    if (req.url?.startsWith("/api/rows")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ roots, rows: await allRows() }));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("./perf-live.html", import.meta.url), "utf8"));
    }
  }).listen(port, "127.0.0.1", () =>
    process.stdout.write(`perf live: http://127.0.0.1:${port}  (watching ${roots.join(", ")})\n`),
  );
}
