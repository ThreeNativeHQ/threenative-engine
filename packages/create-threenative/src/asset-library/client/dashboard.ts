// The Dev Dashboard shell (PRD-918): the side menu and which section shows. Asset Library,
// Animations and Stage / Bundler are the library workbench in three modes; Settings, Performance &
// Health and Playtests are their own panels, built the first time they open.
import { mountPerformance } from "./performance.js";
import { mountPlaytests } from "./playtests.js";
import { mountSettings } from "./settings.js";

export type Section = "assets" | "animations" | "stage" | "settings" | "performance" | "playtests";
const SECTIONS: readonly Section[] = [
  "assets",
  "animations",
  "stage",
  "settings",
  "performance",
  "playtests",
];
const PANELS: Partial<Record<Section, (root: HTMLElement, api: string) => void>> = {
  settings: mountSettings,
  performance: mountPerformance,
  playtests: mountPlaytests,
};

export interface IDashboardConfig {
  /** `/__dashboard/`: its API lives under `api/`. */
  readonly dashboard?: string;
  /** False in the engine's standalone `pnpm asset-library`: only the library section exists. */
  readonly project?: boolean;
}

let section: Section = "assets";
const listeners = new Set<(next: Section, previous: Section) => void>();
const mounted = new Set<Section>();
let api = "/__dashboard/api/";

export const currentSection = (): Section => section;
export const onSection = (listener: (next: Section, previous: Section) => void) => {
  listeners.add(listener);
};

/** In the game page's iframe (the dev pill), not a host's `?embed=1` frame. */
export const inDevShell = (): boolean => window.self !== window.top;

export function setSection(next: Section, options: { readonly replace?: boolean } = {}): void {
  const previous = section;
  section = next;
  document.documentElement.dataset.section = next;
  for (const item of document.querySelectorAll<HTMLElement>("#rail [data-section]"))
    item.toggleAttribute("aria-current", item.dataset.section === next) &&
      item.setAttribute("aria-current", "page");
  const panel = PANELS[next];
  if (panel && !mounted.has(next)) {
    mounted.add(next);
    panel(document.getElementById(`section-${next}`) as HTMLElement, api);
  }
  const url = new URL(location.href);
  if (next === "assets") url.searchParams.delete("section");
  else url.searchParams.set("section", next);
  if (url.href !== location.href)
    history[options.replace ? "replaceState" : "pushState"](null, "", url);
  if (previous !== next) for (const listener of listeners) listener(next, previous);
}

/** Wires the side menu; the first section comes from `?section=` or a Stage link. */
export function initDashboard(config: IDashboardConfig, embed: boolean): void {
  api = `${config.dashboard ?? "/__dashboard/"}api/`;
  if (config.project === false)
    for (const node of document.querySelectorAll<HTMLElement>("#rail [data-project]"))
      node.hidden = true;
  if (embed) return;
  for (const item of document.querySelectorAll<HTMLButtonElement>("#rail [data-section]"))
    item.addEventListener("click", () => setSection(item.dataset.section as Section));
  const back = document.getElementById("rail-game") as HTMLButtonElement;
  if (inDevShell()) {
    back.hidden = false;
    back.onclick = () => window.parent.postMessage({ type: "tn-dashboard:game" }, location.origin);
  }
  const asked = new URLSearchParams(location.search).get("section") as Section | null;
  const first: Section =
    asked && SECTIONS.includes(asked) && (config.project !== false || asked === "assets")
      ? asked
      : location.hash.startsWith("#/stage")
        ? "stage"
        : "assets";
  setSection(first, { replace: true });
  window.addEventListener("popstate", () => {
    const back = new URLSearchParams(location.search).get("section") as Section | null;
    setSection(back && SECTIONS.includes(back) ? back : "assets", { replace: true });
  });
}
