// Playtests (PRD-923): the project's `playtests/**/*.playtest.json`, run one at a time by the dev
// server with the project's own playtest CLI against this dev server, its output streamed live,
// then each assertion's verdict and the run's screenshots.
import { chip, getJson, h, header, sendJson } from "./ui.js";

interface IScenario {
  readonly path: string;
  readonly name: string;
  readonly assertions: number;
  readonly last?: { readonly run: string; readonly pass: boolean; readonly at: string };
}

interface IRun {
  readonly id: string;
  readonly scenario: string;
  readonly status: "running" | "passed" | "failed" | "cancelled" | "error";
  readonly lines?: readonly string[];
  readonly result?: {
    readonly pass: boolean;
    readonly exitCode: number | null;
    readonly assertions: readonly { id: string; pass: boolean; details?: unknown }[];
    readonly diagnostics: readonly { code?: string; message?: string; severity?: string }[];
    readonly images: readonly string[];
  };
}

const TONE = {
  passed: "ok",
  failed: "bad",
  error: "bad",
  cancelled: "warn",
  running: "accent",
} as const;

export function mountPlaytests(root: HTMLElement, api: string): void {
  const check = h("input", "accent-accent", null, { type: "checkbox", id: "playtest-check" });
  const list = h("div", "card min-w-0 divide-y divide-line-soft");
  const runHead = h("div", "flex flex-wrap items-center gap-2");
  const cancel = h("button", "btn", "Cancel", { type: "button", hidden: "" });
  const output = h(
    "pre",
    "max-h-80 min-h-24 overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-[11.5px] whitespace-pre-wrap text-muted",
    "Pick a scenario and press Run. It drives this dev server in its own WebGPU browser.",
  );
  const verdicts = h("div", "grid gap-1.5");
  const images = h("div", "grid gap-3 sm:grid-cols-2");
  root.append(
    header("Playtests", "Scenarios under playtests/, run against this dev server one at a time.", [
      h("label", "flex items-center gap-2 text-muted", [check, "Run typecheck and lint first"]),
    ]),
    h("div", "grid max-w-6xl gap-6 px-8 pt-6 pb-24 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]", [
      h("section", "grid min-w-0 grid-cols-1 content-start gap-3", [
        h("h2", "eyebrow flex h-7 items-center", "Scenarios"),
        list,
      ]),
      h("section", "grid min-w-0 grid-cols-1 content-start gap-3", [
        h("div", "flex h-7 items-center gap-2", [h("h2", "eyebrow flex-1", "Run"), cancel]),
        h("div", "card grid min-w-0 gap-4 p-5", [runHead, output, verdicts, images]),
      ]),
    ]),
  );

  let busy = false;
  const artifact = (run: string, file: string) =>
    `${api}playtests/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`;

  const showRun = (run: IRun) => {
    runHead.replaceChildren(
      h("code", "font-mono text-ink", run.scenario),
      chip(run.status, TONE[run.status]),
    );
    busy = run.status === "running";
    cancel.hidden = !busy;
    const result = run.result;
    verdicts.replaceChildren(
      ...(result
        ? [
            ...result.assertions.map((a) =>
              h("div", "flex items-center gap-2 text-[12.5px]", [
                chip(a.pass ? "pass" : "fail", a.pass ? "ok" : "bad"),
                h("code", "font-mono text-ink", a.id),
              ]),
            ),
            ...result.diagnostics
              .slice(0, 8)
              .map((d) =>
                h("p", "text-[12px] text-muted", [
                  h("code", "font-mono text-warn", d.code ?? d.severity ?? "note"),
                  ` ${d.message ?? ""}`,
                ]),
              ),
          ]
        : []),
    );
    images.replaceChildren(
      ...(result?.images ?? []).slice(0, 6).map((file) =>
        h("figure", "grid gap-1", [
          h("img", "w-full rounded-md border border-line bg-sunken", null, {
            src: artifact(run.id, file),
            alt: file,
            loading: "lazy",
          }),
          h("figcaption", "truncate font-mono text-[11px] text-faint", file),
        ]),
      ),
    );
  };

  const load = async () => {
    const { scenarios, running } = await getJson<{ scenarios: IScenario[]; running?: IRun }>(
      `${api}playtests`,
    );
    if (running) showRun(running);
    list.replaceChildren(
      ...(scenarios.length === 0
        ? [h("p", "px-5 py-4 text-muted", "No playtests/**/*.playtest.json in this project.")]
        : scenarios.map((scenario) => {
            const run = h("button", "btn-accent", "Run", {
              type: "button",
              "data-run": scenario.path,
            });
            run.disabled = busy;
            run.onclick = async () => {
              output.textContent = "";
              try {
                const started = await sendJson<{ id: string; scenario: string }>(
                  `${api}playtests/run`,
                  "POST",
                  { path: scenario.path, check: check.checked },
                );
                showRun({ id: started.id, scenario: started.scenario, status: "running" });
                for (const button of list.querySelectorAll<HTMLButtonElement>("[data-run]"))
                  button.disabled = true;
              } catch (error) {
                output.textContent = (error as Error).message;
              }
            };
            return h("div", "flex items-center gap-3 px-5 py-3", [
              h("div", "min-w-0 flex-1", [
                h("div", "truncate font-medium text-ink", scenario.name),
                h(
                  "code",
                  "block truncate font-mono text-[11px] text-faint",
                  `${scenario.path} · ${scenario.assertions} assertions`,
                ),
              ]),
              scenario.last
                ? chip(
                    scenario.last.pass ? "last: pass" : "last: fail",
                    scenario.last.pass ? "ok" : "bad",
                  )
                : null,
              run,
            ]);
          })),
    );
  };

  cancel.onclick = () => void sendJson(`${api}playtests/cancel`, "POST").catch(() => undefined);
  const stream = new EventSource(`${api}playtests/stream`);
  stream.addEventListener("start", (event) => {
    output.textContent = "";
    showRun({
      ...(JSON.parse((event as MessageEvent).data) as { id: string; scenario: string }),
      status: "running",
    });
  });
  stream.addEventListener("line", (event) => {
    output.textContent += `${JSON.parse((event as MessageEvent).data) as string}\n`;
    output.scrollTop = output.scrollHeight;
  });
  stream.addEventListener("done", (event) => {
    showRun(JSON.parse((event as MessageEvent).data) as IRun);
    void load();
  });
  void load().catch((error: Error) =>
    list.replaceChildren(h("p", "px-5 py-4 text-danger", error.message)),
  );
}
