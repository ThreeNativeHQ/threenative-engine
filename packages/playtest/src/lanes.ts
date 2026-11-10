// The four lanes a scenario runs on, named the way the CLI's `--target` names them. No imports, so
// the registry, the report and the runners can all read it without a cycle.
import type { PlaytestTarget } from "./scenario/schema-base.js";

export type PlaytestLane = "browser" | "android" | "desktop" | "ios";
export const PLAYTEST_LANES: readonly PlaytestLane[] = ["browser", "android", "desktop", "ios"];

/** The lanes that observe network requests: CDP in the browser, the host's fetch observation on desktop. */
export const NETWORK_OBSERVER_LANES: readonly PlaytestLane[] = ["browser", "desktop"];

/** The lane a scenario file's `target` field means: `web` is the browser, `bevy` is the native desktop host. */
export function laneOfScenarioTarget(target: PlaytestTarget): PlaytestLane {
  return target === "web" ? "browser" : "desktop";
}
