// Which arm this build draws. One build, one selector, three arms — `virtual` arrives with
// PRD-283 and is named here so the harness is built for it rather than retrofitted around it.

export const QUARRY_ARMS = ["dense", "decimated", "virtual"] as const;

export type QuarryArm = (typeof QUARRY_ARMS)[number];

export const DEFAULT_ARM: QuarryArm = "dense";

/** The `.glb` each arm draws its bodies from. The floor is shared and is not listed here. */
export function bodiesModelPath(arm: QuarryArm): string {
  switch (arm) {
    case "dense":
      return "assets/quarry-bodies-dense.glb";
    case "decimated":
      return "assets/quarry-bodies-decimated.glb";
    case "virtual":
      return "assets/quarry-bodies-virtual.glb";
  }
}

export function parseArm(value: string | null | undefined): QuarryArm {
  if (value === undefined || value === null || value === "") return DEFAULT_ARM;
  const found = QUARRY_ARMS.find((arm) => arm === value);
  // Fails closed: a misspelled arm would otherwise silently measure the default one and be
  // reported as the arm that was asked for, which is the one mistake this instrument cannot make.
  if (found === undefined)
    throw new Error(`TN_QUARRY_UNKNOWN_ARM: '${value}' is not one of ${QUARRY_ARMS.join(", ")}.`);
  return found;
}

/** The arm named in `?arm=` on the web, or the default. Native entries pass their arm directly. */
export function armFromLocation(): QuarryArm {
  const search = globalThis.location?.search;
  if (typeof search !== "string") return DEFAULT_ARM;
  return parseArm(new URLSearchParams(search).get("arm"));
}

/**
 * Whether the route draws only what the view holds, from `?viewCull=` on the web.
 *
 * `?viewCull=off` is PRD-600's measurement arm: every cluster and every copy is drawn, exactly as the
 * route drew them before the cut was pruned by the view, so two runs of the same build differ only by
 * the cull. Anything else is on, and a misspelling fails closed rather than measuring the wrong arm.
 */
export function viewCullFromLocation(): boolean {
  // A native entry has no URL, so the before arm is baked in instead: `VITE_QUARRY_VIEW_CULL=off`
  // at bundle time builds the every-cluster arm of the same source.
  if (import.meta.env?.VITE_QUARRY_VIEW_CULL === "off") return false;
  const search = globalThis.location?.search;
  if (typeof search !== "string") return true;
  const value = new URLSearchParams(search).get("viewCull");
  if (value === undefined || value === null || value === "") return true;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`TN_QUARRY_UNKNOWN_VIEW_CULL: '${value}' is on or off.`);
}

export const QUARRY_MODES = ["control", "free", "pose", "route"] as const;

export type QuarryMode = (typeof QUARRY_MODES)[number];

/**
 * `?mode=free` hands the walk to a person, `?mode=control` parks the camera over the pit floor so
 * the control surface can be diffed between arms, `?mode=pose` stands still on one route frame so a
 * before/after pair is the same pose, and anything else drives the fixed route.
 */
export function modeFromLocation(): QuarryMode {
  const search = globalThis.location?.search;
  if (typeof search !== "string") return "route";
  const value = new URLSearchParams(search).get("mode");
  if (value === undefined || value === null || value === "") return "route";
  const found = QUARRY_MODES.find((mode) => mode === value);
  // Fails closed for the same reason the arm does: a misspelled mode would silently walk the route
  // and be reported as whichever mode was asked for.
  if (found === undefined)
    throw new Error(`TN_QUARRY_UNKNOWN_MODE: '${value}' is not one of ${QUARRY_MODES.join(", ")}.`);
  return found;
}

/**
 * The route frame `?mode=pose` stands on, from `?frame=`.
 *
 * A route screenshot is taken when a scenario step's ticks elapse, and how many route frames pass
 * per tick depends on the machine — so two runs of two builds frame different poses and an image
 * difference between them means nothing. Freezing the pose is what makes a pair comparable.
 */
export function poseFrameFromLocation(): number {
  const search = globalThis.location?.search;
  if (typeof search !== "string") return 0;
  const value = new URLSearchParams(search).get("frame");
  if (value === null || value === "") return 0;
  const frame = Number(value);
  // Fails closed, like the arm and the mode: a paused route on the wrong frame is a pair of images
  // that are silently not the same pose.
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new Error(`TN_QUARRY_UNKNOWN_FRAME: '${value}' is not a route frame index.`);
  return frame;
}
