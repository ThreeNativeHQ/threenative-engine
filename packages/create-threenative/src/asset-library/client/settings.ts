// Settings (PRD-918): Game Config edits `threenative.config.ts` through the dev server, which
// validates every change with the same loader `threenative build` runs and applies it at once;
// Telemetry holds the dev-run crash switch (a project setting) and the two sharing switches
// (consent on this machine only, off by default).
import { chip, getJson, h, header, sendJson, toggle } from "./ui.js";

interface IField {
  readonly path: string;
  readonly label: string;
  readonly group: string;
  readonly kind: "text" | "integer" | "number" | "boolean" | "choice" | "color";
  readonly options?: readonly (string | boolean)[];
  readonly orNumber?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly hint?: string;
}

interface IConfigResponse {
  readonly fields: readonly IField[];
  readonly authored: Record<string, unknown>;
  readonly resolved: Record<string, unknown>;
  readonly expressions: readonly string[];
  readonly restarting?: boolean;
}

interface ITelemetry {
  readonly crashReports: boolean;
  readonly shareProcedurals: boolean;
  readonly shareSessionTraces: boolean;
  readonly prefsFile: string;
  readonly models: readonly string[];
}

interface ITrace {
  readonly id: string;
  readonly agent: string;
  readonly bytes: number;
  readonly models: readonly string[];
  readonly family?: string;
  readonly skip?: string;
  readonly submitted: boolean;
}

const SAVED = "tn-dashboard:saved";

export function mountSettings(root: HTMLElement, api: string): void {
  const status = h("div", "flex items-center gap-2 text-muted", null, {
    role: "status",
    id: "settings-status",
  });
  const tabs = h("div", "flex gap-1 px-8 pt-4", null, {
    role: "tablist",
    "aria-label": "Settings",
  });
  const body = h("div", "px-8 pt-5 pb-12");
  root.append(
    header(
      "Settings",
      "threenative.config.ts and dev-run telemetry. Changes apply to the running dev server.",
      [status],
    ),
    tabs,
    body,
  );
  const say = (text: string, tone: Parameters<typeof chip>[1] = "muted") =>
    status.replaceChildren(chip(text, tone));
  // A save reloads the game page (Vite), and the dev shell reopens the Dashboard: say what happened.
  const saved = sessionStorage.getItem(SAVED);
  if (saved) {
    sessionStorage.removeItem(SAVED);
    say(saved, "ok");
  }
  const views: Record<string, () => Promise<void>> = {
    config: () => gameConfig(body, api, say),
    telemetry: () => telemetry(body, api, say),
  };
  const select = (name: string) => {
    for (const tab of tabs.children)
      tab.setAttribute("aria-selected", String((tab as HTMLElement).dataset.tab === name));
    const url = new URL(location.href);
    url.searchParams.set("tab", name);
    history.replaceState(null, "", url);
    body.replaceChildren(h("p", "text-muted", "Loading"));
    views[name]?.().catch((error: Error) =>
      body.replaceChildren(h("p", "text-danger", error.message)),
    );
  };
  for (const [name, label] of [
    ["config", "Game Config"],
    ["telemetry", "Telemetry"],
  ] as const) {
    const tab = h(
      "button",
      "tab cursor-pointer rounded-md px-3 py-1.5 font-semibold text-muted hover:text-ink aria-selected:bg-raised aria-selected:text-ink",
      label,
      {
        type: "button",
        role: "tab",
        "data-tab": name,
        id: `settings-tab-${name}`,
      },
    );
    tab.onclick = () => select(name);
    tabs.append(tab);
  }
  select(new URLSearchParams(location.search).get("tab") === "telemetry" ? "telemetry" : "config");
}

const display = (value: unknown) => (value === undefined ? "" : String(value));

function control(field: IField, value: unknown, commit: (next: unknown) => void): HTMLElement {
  if (field.kind === "boolean") return toggle(field.label, value === true, commit);
  if (field.kind === "choice") {
    const select = h("select", "field w-56", null, { "aria-label": field.label, name: field.path });
    const options = (field.options ?? []).map(String);
    // An unset key with no resolved value: the engine decides, so say so instead of a blank box.
    if (!options.includes(display(value)))
      select.append(h("option", "", "Engine default", { value: "" }));
    for (const option of options) select.append(h("option", "", option, { value: option }));
    select.value = options.includes(display(value)) ? display(value) : "";
    select.onchange = () => commit(select.value === "" ? null : select.value);
    return select;
  }
  if (field.kind === "color") {
    const wrap = h("div", "flex items-center gap-2");
    const picker = h(
      "input",
      "size-8 cursor-pointer rounded border border-line bg-transparent",
      null,
      {
        type: "color",
        "aria-label": field.label,
        name: field.path,
      },
    );
    picker.value = /^#[0-9a-f]{6}$/iu.test(display(value)) ? display(value) : "#000000";
    const text = h("code", "font-mono text-muted", display(value));
    picker.onchange = () => {
      text.textContent = picker.value;
      commit(picker.value);
    };
    wrap.append(picker, text);
    return wrap;
  }
  const numeric = field.kind === "integer" || field.kind === "number";
  const input = h("input", "field w-56", null, {
    "aria-label": field.label,
    name: field.path,
    type: "text",
    inputmode: numeric ? "decimal" : "text",
    placeholder: field.hint ?? "",
  });
  input.value = display(value);
  input.onchange = () => {
    const raw = input.value.trim();
    if (raw === "") return commit(null);
    const literal = field.options?.find((option) => String(option) === raw);
    if (literal !== undefined) return commit(literal);
    commit(numeric ? Number(raw) : raw);
  };
  return input;
}

async function gameConfig(
  body: HTMLElement,
  api: string,
  say: (text: string, tone?: Parameters<typeof chip>[1]) => void,
) {
  let view = await getJson<IConfigResponse>(`${api}config`);
  const errors = new Map<string, HTMLElement>();
  const save = async (path: string, value: unknown) => {
    for (const node of errors.values()) node.textContent = "";
    say("Saving");
    try {
      view = await sendJson<IConfigResponse>(`${api}config`, "PATCH", {
        changes: { [path]: value },
      });
      const message = view.restarting
        ? "Engine switched. The dev server is restarting"
        : "Saved threenative.config.ts. The game reloaded with it";
      sessionStorage.setItem(SAVED, message);
      say(message, view.restarting ? "warn" : "ok");
      window.parent.postMessage({ type: "tn-dashboard:config-updated", path }, location.origin);
      render();
    } catch (error) {
      const fields = (error as { fields?: Record<string, string> }).fields ?? {};
      say("Not saved: the config did not validate", "bad");
      const target = errors.get(path);
      if (target) target.textContent = fields[path] ?? (error as Error).message;
      render(false);
    }
  };
  const render = (refresh = true) => {
    if (!refresh) return;
    errors.clear();
    const groups = new Map<string, IField[]>();
    for (const field of view.fields)
      groups.set(field.group, [...(groups.get(field.group) ?? []), field]);
    const cards = [...groups].map(([group, fields]) =>
      h("section", "card", [
        h("h2", "eyebrow border-b border-line-soft px-5 py-3", group),
        h(
          "div",
          "divide-y divide-line-soft",
          fields.map((field) => {
            const authored = field.path in view.authored;
            const expression = view.expressions.includes(field.path);
            const value = authored ? view.authored[field.path] : view.resolved[field.path];
            const error = h("p", "text-danger text-[12px]", "", { "data-error": field.path });
            errors.set(field.path, error);
            const reset = h("button", "tool", "↺", {
              type: "button",
              title: `Back to the default for ${field.label}`,
            });
            reset.onclick = () => void save(field.path, null);
            return h(
              "div",
              "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 px-5 py-3",
              [
                h("div", "min-w-0", [
                  h("div", "flex items-center gap-2", [
                    h("span", "font-medium text-ink", field.label),
                    authored ? chip("set", "accent") : chip("default"),
                  ]),
                  h("code", "font-mono text-[11px] text-faint", field.path),
                  field.hint ? h("p", "text-[12px] text-muted", field.hint) : null,
                  error,
                ]),
                h("div", "flex items-center gap-2", [
                  expression
                    ? h("span", "text-muted", "Expression: edit it in threenative.config.ts")
                    : control(field, value, (next) => void save(field.path, next)),
                  authored && !expression ? reset : null,
                ]),
              ],
            );
          }),
        ),
      ]),
    );
    body.replaceChildren(h("div", "grid max-w-5xl gap-5 xl:grid-cols-2", cards));
  };
  render();
}

async function telemetry(
  body: HTMLElement,
  api: string,
  say: (text: string, tone?: Parameters<typeof chip>[1]) => void,
) {
  let state = await getJson<ITelemetry>(`${api}telemetry`);
  const patch = async (change: Partial<ITelemetry>) => {
    say("Saving");
    try {
      state = await sendJson<ITelemetry>(`${api}telemetry`, "PATCH", change);
      say("Saved", "ok");
      render();
    } catch (error) {
      say((error as Error).message, "bad");
    }
  };
  const traceList = h("div", "grid gap-2");
  const procList = h("div", "grid gap-2");
  const preview = h(
    "pre",
    "max-h-72 overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-[11px] whitespace-pre-wrap text-muted",
    null,
    { hidden: "" },
  );

  const loadTraces = async () => {
    const { traces } = await getJson<{ traces: ITrace[] }>(`${api}telemetry/traces`);
    traceList.replaceChildren(
      ...(traces.length === 0
        ? [
            h(
              "p",
              "text-muted",
              "No Claude Code, Codex or pi sessions recorded for this project yet.",
            ),
          ]
        : traces.slice(0, 12).map((trace) => {
            const run = h("button", "btn", "Preview scrubbed", { type: "button" });
            run.disabled = !trace.family;
            run.onclick = async () => {
              preview.hidden = false;
              preview.textContent = "Scrubbing locally (dry run, nothing is sent)";
              const result = await sendJson<{
                records: number;
                redactions: number;
                bytes: number;
                sample: string[];
                aborted?: string;
              }>(`${api}telemetry/traces/preview`, "POST", { id: trace.id }).catch(
                (error: Error) => ({
                  aborted: error.message,
                  records: 0,
                  redactions: 0,
                  bytes: 0,
                  sample: [],
                }),
              );
              preview.textContent = result.aborted
                ? `Aborted: ${result.aborted}`
                : `${result.records} records, ${result.redactions} redactions, ${(result.bytes / 1024).toFixed(1)} KB after scrubbing. First records as they would be sent:\n\n${result.sample.join("\n\n")}`;
            };
            return h(
              "div",
              "flex flex-wrap items-center gap-2 rounded-md border border-line-soft bg-sunken px-3 py-2",
              [
                h("code", "font-mono text-[12px] text-ink", trace.id.slice(0, 42)),
                chip(trace.agent),
                trace.family ? chip(trace.family, "ok") : chip("skipped", "warn"),
                trace.submitted ? chip("sent", "accent") : null,
                h(
                  "span",
                  "min-w-0 flex-1 truncate text-[12px] text-faint",
                  trace.skip ?? trace.models.join(", "),
                ),
                run,
              ],
            );
          })),
    );
  };
  const loadProcedurals = async () => {
    const { files } = await getJson<{ files: { path: string; excluded?: string }[] }>(
      `${api}telemetry/procedurals`,
    );
    procList.replaceChildren(
      ...(files.length === 0
        ? [
            h(
              "p",
              "text-muted",
              "No saved procedural bakes yet. Bake one in the Asset Library and press Save to assets/.",
            ),
          ]
        : files.map((file) => {
            const share = h("button", "btn", "Share", { type: "button" });
            share.disabled = !state.shareProcedurals || !!file.excluded;
            share.onclick = async () => {
              share.disabled = true;
              share.textContent = "Sharing";
              try {
                await sendJson(`${api}telemetry/procedurals/share`, "POST", { path: file.path });
                share.textContent = "Shared";
              } catch (error) {
                share.textContent = "Failed";
                say((error as Error).message, "bad");
              }
            };
            return h(
              "div",
              "flex items-center gap-2 rounded-md border border-line-soft bg-sunken px-3 py-2",
              [
                h("code", "min-w-0 flex-1 truncate font-mono text-[12px]", file.path),
                file.excluded ? chip(file.excluded, "warn") : null,
                share,
              ],
            );
          })),
    );
  };

  const card = (
    title: string,
    badge: HTMLElement,
    sw: HTMLElement,
    text: (Node | string)[],
    extra: Node[] = [],
  ) =>
    h("section", "card grid gap-3 p-5", [
      h("div", "flex items-start gap-4", [
        h("div", "min-w-0 flex-1", [
          h("div", "flex flex-wrap items-center gap-2", [
            h("h2", "text-[15px] font-semibold text-ink", title),
            badge,
          ]),
          ...text.map((t) =>
            typeof t === "string" ? h("p", "mt-1.5 max-w-3xl text-muted leading-relaxed", t) : t,
          ),
        ]),
        sw,
      ]),
      ...extra,
    ]);

  const render = () => {
    const shareNow = h("button", "btn-accent", "Share eligible sessions now", { type: "button" });
    shareNow.disabled = !state.shareSessionTraces;
    shareNow.onclick = async () => {
      shareNow.disabled = true;
      try {
        const report = await sendJson<{
          sent: string[];
          aborted: unknown[];
          failed: { reason: string }[];
        }>(`${api}telemetry/traces/share`, "POST");
        say(
          `${report.sent.length} sent, ${report.aborted.length} aborted by the scrubber, ${report.failed.length} failed`,
          report.failed.length ? "warn" : "ok",
        );
        await loadTraces();
      } catch (error) {
        say((error as Error).message, "bad");
      } finally {
        shareNow.disabled = !state.shareSessionTraces;
      }
    };
    body.replaceChildren(
      h("div", "grid max-w-5xl gap-5", [
        h(
          "div",
          "flex items-center gap-3 rounded-[10px] border border-accent/30 bg-accent-soft px-4 py-3",
          [
            h("span", "size-2 rounded-full bg-live"),
            h("p", "text-ink", [
              h("b", "font-semibold", "Active on dev runs only. "),
              "Never in production builds: a shipped game sends nothing from a player's machine.",
            ]),
          ],
        ),
        card(
          "Crash & engine error data",
          chip("On by default", "ok"),
          toggle(
            "Crash & engine error data",
            state.crashReports,
            (on) => void patch({ crashReports: on }),
          ),
          [
            "Sends a dev run's TN_* error codes with a scrubbed message, the game name, engine version and platform to threenative.com, so engine bugs get fixed without a bug report. No stack, path, URL or personal data.",
            h("p", "text-[12px] text-faint", [
              "Project setting: ",
              h("code", "font-mono", "telemetry.crashReports"),
              " in threenative.config.ts.",
            ]),
          ],
        ),
        card(
          "Share procedural assets with the community library",
          chip("Off by default", "muted"),
          toggle(
            "Share procedural assets",
            state.shareProcedurals,
            (on) => void patch({ shareProcedurals: on }),
          ),
          [
            "Uploads the self-contained procedural .glb bakes you save under assets/procedural/ (binary glTF 2.0, 25 MB at most) to ThreeNative's Cloudflare storage, so other Asset Library users can browse and reuse them. Downloads, levels and LOD siblings are never shared.",
          ],
          [procList],
        ),
        card(
          "Share sanitized AI session traces",
          chip("Off by default", "muted"),
          toggle(
            "Share sanitized AI session traces",
            state.shareSessionTraces,
            (on) => void patch({ shareSessionTraces: on }),
          ),
          [
            "Helps train Inkling Mini 2, a fine-tuned local model optimized for ThreeNative. When on, this project's coding-agent sessions are scrubbed on your machine and uploaded.",
            h("ul", "mt-2 grid gap-1 text-muted [&>li]:flex [&>li]:gap-2", [
              h("li", "", [
                h("span", "text-accent", "•"),
                "Off by default. Your consent lives on this machine only, never in the project repository.",
              ]),
              h("li", "", [
                h("span", "text-accent", "•"),
                h("span", "", [
                  "Only sessions run entirely on ",
                  ...state.models.flatMap((m, i) => [
                    i ? ", " : "",
                    h("b", "text-ink capitalize", m),
                  ]),
                  ". Every other model is skipped.",
                ]),
              ]),
              h("li", "", [
                h("span", "text-accent", "•"),
                "Secrets (API keys, tokens, private keys, .env files) and personal data (username, home folder, host name, emails, IPs) are stripped locally before anything is sent. If anything survives the scrub, nothing is sent.",
              ]),
            ]),
          ],
          [
            h("div", "flex flex-wrap items-center gap-2", [
              h("span", "eyebrow flex-1", "This project's sessions"),
              shareNow,
            ]),
            traceList,
            preview,
          ],
        ),
        h("p", "text-[12px] text-faint", [
          "Sharing consent file: ",
          h("code", "font-mono", state.prefsFile),
        ]),
      ]),
    );
    void loadTraces().catch((error: Error) =>
      traceList.replaceChildren(h("p", "text-danger", error.message)),
    );
    void loadProcedurals().catch((error: Error) =>
      procList.replaceChildren(h("p", "text-danger", error.message)),
    );
  };
  render();
}
