// Performance & Health (PRD-923): the game page's own `TN_*` markers (kept by the dev shell's ring
// buffer, never re-measured here) as sparklines, a phase breakdown and a warnings log, plus the
// `threenative doctor` checks and the asset cook totals from the dev server.
import { chip, getJson, h, header, mb } from "./ui.js";

interface IMarker {
  readonly t: number;
  readonly level: string;
  readonly code: string;
  readonly text: string;
}

interface IHealth {
  readonly doctor: {
    readonly pass: boolean;
    readonly checks: readonly { name: string; status: string; detail: string; fix?: string }[];
  };
  readonly assets?: {
    readonly before: number;
    readonly after: number;
    readonly rows: readonly {
      name: string;
      kind: string;
      before: number;
      after: number;
      quality?: string;
    }[];
  };
  readonly at: string;
}

type Window = Record<string, unknown>;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const at = (object: unknown, path: string): number | undefined =>
  num(
    path
      .split(".")
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], object),
  );

/** A frame-budget line's JSON, or undefined. */
function budget(marker: IMarker): Window | undefined {
  const start = marker.text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(marker.text.slice(start)) as Window;
  } catch {
    return undefined;
  }
}

const SERIES = [
  {
    key: "fps",
    label: "FPS",
    read: (w: Window) => num(w.presentedFps) ?? num(w.fps),
    unit: "",
    digits: 0,
  },
  {
    key: "p95",
    label: "Frame p95",
    read: (w: Window) => at(w, "presented.p95") ?? at(w, "frame.p95"),
    unit: " ms",
    digits: 1,
  },
  {
    key: "draws",
    label: "Draw calls",
    read: (w: Window) => at(w, "passes.main.draws.mean"),
    unit: "",
    digits: 0,
  },
  {
    key: "triangles",
    label: "Triangles",
    read: (w: Window) => at(w, "passes.main.triangles.mean"),
    unit: "",
    digits: 0,
  },
  {
    key: "scale",
    label: "Resolution scale",
    read: (w: Window) => at(w, "surface.resolutionScale"),
    unit: "",
    digits: 2,
  },
] as const;

function sparkline(values: readonly number[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 32");
  svg.setAttribute("class", "h-9 w-full");
  svg.setAttribute("preserveAspectRatio", "none");
  if (values.length > 1) {
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const points = values
      .map((v, i) => `${(i / (values.length - 1)) * 120},${30 - ((v - min) / span) * 28}`)
      .join(" ");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", points);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(line);
  }
  return svg;
}

const compact = (value: number, digits: number) =>
  value >= 1e6
    ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1e4
      ? `${(value / 1e3).toFixed(0)}k`
      : value.toFixed(digits);

export function mountPerformance(root: HTMLElement, api: string): void {
  const inShell = window.self !== window.top;
  const post = (type: string) => window.parent.postMessage({ type }, location.origin);
  const dockButton = h("button", "btn", "Dock live strip", {
    type: "button",
    id: "perf-dock",
    title: "Back to the game with a live FPS, p95 and draws readout",
  });
  dockButton.disabled = !inShell;
  dockButton.onclick = () => post("tn-dashboard:dock");
  const refresh = h("button", "btn", "Refresh", { type: "button" });
  refresh.disabled = !inShell;
  refresh.onclick = () => post("tn-dashboard:request-markers");
  const tiles = h("div", "grid gap-3 sm:grid-cols-2 xl:grid-cols-5");
  const phases = h("div", "grid gap-1.5");
  const filter = h("input", "field w-56", null, {
    placeholder: "Filter markers",
    "aria-label": "Filter markers",
  });
  const clear = h("button", "btn", "Clear", { type: "button" });
  const log = h(
    "div",
    "max-h-80 overflow-y-auto rounded-md border border-line bg-sunken font-mono text-[11.5px]",
  );
  const health = h("div", "grid gap-4");
  const recheck = h("button", "btn", "Re-check", { type: "button" });
  root.append(
    header(
      "Performance & Health",
      "Read from the running game's own TN_* markers (last 60 s) and threenative doctor.",
      [refresh, dockButton],
    ),
    h("div", "grid max-w-6xl gap-6 px-8 pt-6 pb-24", [
      h("section", "grid gap-3", [h("h2", "eyebrow", "Frame budget"), tiles]),
      h("div", "grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]", [
        h("section", "card grid content-start gap-3 p-5", [
          h("h2", "eyebrow", "Where the frame goes (mean ms)"),
          phases,
        ]),
        h("section", "card grid content-start gap-3 p-5", [
          h("div", "flex flex-wrap items-center gap-2", [
            h("h2", "eyebrow flex-1", "Warnings and markers"),
            filter,
            clear,
          ]),
          log,
        ]),
      ]),
      h("section", "grid gap-3", [
        h("div", "flex items-center gap-2", [h("h2", "eyebrow flex-1", "Project health"), recheck]),
        health,
      ]),
    ]),
  );

  let markers: IMarker[] = [];
  const render = () => {
    const windows = markers
      .filter((m) => m.code === "TN_FRAME_BUDGET")
      .map(budget)
      .filter((w): w is Window => !!w);
    tiles.replaceChildren(
      ...SERIES.map((series) => {
        const values = windows.map(series.read).filter((v): v is number => v !== undefined);
        const latest = values.at(-1);
        return h("div", "card grid gap-1 p-4 text-accent", [
          h("span", "eyebrow", series.label),
          h(
            "span",
            "text-[22px] font-semibold tabular-nums text-ink",
            latest === undefined ? "–" : `${compact(latest, series.digits)}${series.unit}`,
          ),
          values.length > 1
            ? sparkline(values)
            : h(
                "span",
                "h-9 text-[11px] text-faint",
                values.length ? "One window so far" : "No reading",
              ),
        ]);
      }),
    );
    const last = windows.at(-1);
    const shares = (last?.phases ?? {}) as Record<string, { mean?: number }>;
    const rows = Object.entries(shares)
      .map(([name, summary]) => [name, num(summary?.mean) ?? 0] as const)
      .filter(([, mean]) => mean > 0)
      .sort((a, b) => b[1] - a[1]);
    const top = rows[0]?.[1] ?? 1;
    phases.replaceChildren(
      ...(rows.length === 0
        ? [
            h(
              "p",
              "text-muted",
              inShell
                ? "Waiting for the first TN_FRAME_BUDGET window from the game."
                : "Open the Dashboard from the game page's pill to read its markers.",
            ),
          ]
        : rows.map(([name, mean]) =>
            h("div", "grid grid-cols-[110px_minmax(0,1fr)_56px] items-center gap-3", [
              h("span", "truncate text-muted", name),
              h("span", "h-2 rounded-full bg-raised", [
                h("span", "block h-full rounded-full bg-accent", null, {
                  style: `width:${Math.max(2, (mean / top) * 100)}%`,
                }),
              ]),
              h("span", "text-right font-mono tabular-nums text-ink", mean.toFixed(2)),
            ]),
          )),
    );
    const words = filter.value.toLowerCase();
    const warnings = markers.filter(
      (m) =>
        m.code !== "TN_FRAME_BUDGET" &&
        m.code !== "TN_FRAME_SPANS" &&
        (!words || m.text.toLowerCase().includes(words)),
    );
    log.replaceChildren(
      ...(warnings.length === 0
        ? [
            h(
              "p",
              "px-3 py-3 font-sans text-muted",
              "No TN_SCENE_WARNING, TN_HOT_CALL or other warning markers in the last 60 s.",
            ),
          ]
        : warnings
            .slice(-200)
            .reverse()
            .map((m) =>
              h("div", "flex gap-2 border-b border-line-soft px-3 py-1.5 last:border-0", [
                h(
                  "span",
                  m.level === "error"
                    ? "text-danger"
                    : m.level === "warn"
                      ? "text-warn"
                      : "text-story",
                  m.code,
                ),
                h(
                  "span",
                  "min-w-0 flex-1 break-words text-muted",
                  m.text
                    .slice(m.code.length)
                    .replace(/^[:\s]+/u, "")
                    .slice(0, 600)
                    // A JSON payload has no spaces: give it break points at its keys, not mid-word.
                    .replace(/,(?=")/gu, ", "),
                ),
              ]),
            )),
    );
  };
  filter.oninput = render;
  clear.onclick = () => {
    markers = markers.filter((m) => m.code === "TN_FRAME_BUDGET" || m.code === "TN_FRAME_SPANS");
    post("tn-dashboard:clear-markers");
    render();
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const data = event.data as { type?: string; events?: IMarker[] };
    if (data?.type === "tn-dashboard:markers" && Array.isArray(data.events)) {
      markers = data.events;
      render();
    }
  });
  render();
  if (inShell) post("tn-dashboard:request-markers");
  // The panel only reads what the game page kept: one request every 2 s while this section shows.
  setInterval(() => {
    if (
      inShell &&
      document.documentElement.dataset.section === "performance" &&
      document.visibilityState === "visible"
    )
      post("tn-dashboard:request-markers");
  }, 2000);

  const loadHealth = async (refreshed: boolean) => {
    recheck.disabled = true;
    health.replaceChildren(h("p", "text-muted", "Running threenative doctor"));
    try {
      const report = await getJson<IHealth>(`${api}health${refreshed ? "?refresh=1" : ""}`);
      const tone = (status: string) =>
        status === "ok" ? "ok" : status === "warn" ? "warn" : "bad";
      health.replaceChildren(
        h("div", "card divide-y divide-line-soft", [
          h("div", "flex items-center gap-2 px-5 py-3", [
            report.doctor.pass ? chip("doctor passes", "ok") : chip("doctor fails", "bad"),
            h(
              "span",
              "text-[12px] text-faint",
              `Checked ${new Date(report.at).toLocaleTimeString()}`,
            ),
          ]),
          ...report.doctor.checks.map((check) =>
            h("div", "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-5 py-2.5", [
              chip(check.status, tone(check.status)),
              h("div", "min-w-0", [
                h("span", "font-medium text-ink", check.name),
                h("p", "text-[12px] break-words text-muted", check.detail),
                check.fix
                  ? h("p", "text-[12px] text-faint", ["Fix: ", h("code", "font-mono", check.fix)])
                  : null,
              ]),
            ]),
          ),
        ]),
        report.assets
          ? h("div", "card p-5", [
              h("div", "flex items-baseline gap-3", [
                h("span", "eyebrow flex-1", "Cooked assets"),
                h(
                  "span",
                  "font-mono text-ink",
                  `${mb(report.assets.before)} → ${mb(report.assets.after)}`,
                ),
              ]),
              h(
                "div",
                "mt-3 grid gap-1",
                report.assets.rows
                  .slice(0, 8)
                  .map((row) =>
                    h("div", "flex gap-3 text-[12px]", [
                      h("span", "min-w-0 flex-1 truncate text-muted", row.name),
                      row.quality
                        ? chip(row.quality, row.quality === "pass" ? "ok" : "warn")
                        : null,
                      h("span", "font-mono text-ink", mb(row.after)),
                    ]),
                  ),
              ),
            ])
          : h(
              "p",
              "text-[12px] text-faint",
              "No public/assets.manifest.json yet: the asset cook runs on threenative build.",
            ),
      );
    } catch (error) {
      health.replaceChildren(h("p", "text-danger", (error as Error).message));
    } finally {
      recheck.disabled = false;
    }
  };
  recheck.onclick = () => void loadHealth(true);
  void loadHealth(false);
}
