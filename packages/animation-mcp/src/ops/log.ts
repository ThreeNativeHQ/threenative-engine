import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnimationPose,
  type AttachmentMode,
  type TransformValue,
  migrateRecipe,
  upsertKeyframe,
} from "../client/recipe.js";
import type { AnchorInfo } from "./landmarks.js";

/** The clip name the calibrator view uses for a pose that applies to every clip. */
export const DEFAULT_CLIP_KEY = "$default";

/** Puts the prop on a bone. The first op of a log; a later one replaces the prop or the anchor. */
export interface AttachOp {
  readonly anchor: AnchorInfo;
  readonly attached: string;
  readonly op: "attach";
}

/** One keyed offset for one clip, at one time in seconds. */
export interface KeyOp {
  readonly clip: string;
  readonly op: "key";
  readonly time: number;
  readonly transform: TransformValue;
  readonly attachment?: AttachmentMode;
}

export type AnimationOp = AttachOp | KeyOp;

/**
 * `<model>.anim.json`, next to the source GLB: the whole edit history, oldest first.
 *
 * `host` is the source and never changes; everything a human or an agent decided lives in `ops`.
 * Replaying them is deterministic, so the log is the git diff, the undo stack and the answer to
 * "what did João change". Version 3 pose recipes still load: they upgrade to the same ops a
 * caller would have written.
 */
export interface AnimationLog {
  readonly host: string;
  readonly ops: readonly AnimationOp[];
  readonly version: 4;
}

export interface ReplayResult {
  readonly anchor: AnchorInfo;
  readonly attached: string;
  readonly host: string;
  readonly poses: Readonly<Record<string, AnimationPose>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function numbers(value: unknown, length: number, what: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((item) => Number.isFinite(item))
  )
    throw new Error(`${what} must be ${length} finite numbers.`);
  return value as number[];
}

function transform(value: unknown): TransformValue {
  if (!isRecord(value)) throw new Error("A key op needs a transform object.");
  return {
    position: numbers(value.position, 3, "transform.position") as [number, number, number],
    rotation: numbers(value.rotation, 3, "transform.rotation") as [number, number, number],
    scale: numbers(value.scale, 3, "transform.scale") as [number, number, number],
  };
}

function anchorInfo(value: unknown): AnchorInfo {
  if (!isRecord(value)) throw new Error("An attach op needs an anchor object.");
  const { id, label, node, source } = value;
  if (typeof id !== "string" || typeof label !== "string" || typeof node !== "string")
    throw new Error("An anchor needs a string id, label and node.");
  if (source !== "detected" && source !== "estimated")
    throw new Error("An anchor source is 'detected' or 'estimated'.");
  return { id: id as AnchorInfo["id"], label, node, source };
}

function attachmentMode(value: unknown): AttachmentMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "attached" && value !== "detached")
    throw new Error("A key op attachment is 'attached' or 'detached'.");
  return value;
}

function op(value: unknown): AnimationOp {
  if (!isRecord(value)) throw new Error("Every op must be an object.");
  if (value.op === "attach") {
    if (typeof value.attached !== "string" || value.attached.length === 0)
      throw new Error("An attach op names the attached GLB.");
    return { anchor: anchorInfo(value.anchor), attached: value.attached, op: "attach" };
  }
  if (value.op === "key") {
    if (typeof value.clip !== "string" || value.clip.length === 0)
      throw new Error("A key op names its clip.");
    if (typeof value.time !== "number" || !Number.isFinite(value.time) || value.time < 0)
      throw new Error("A key op needs a finite time of zero or more.");
    const mode = attachmentMode(value.attachment);
    return {
      clip: value.clip,
      op: "key",
      time: value.time,
      transform: transform(value.transform),
      ...(mode === undefined ? {} : { attachment: mode }),
    };
  }
  throw new Error(`Unknown animation op '${String(value.op)}'.`);
}

/** A version 3 recipe becomes the ops a caller would have written by hand, in a fixed order:
 * attach, then the default track, then each clip sorted by name and each keyframe by time. */
function fromRecipe(recipe: ReturnType<typeof migrateRecipe>): AnimationLog {
  if (recipe === undefined) throw new Error("Unsupported animation recipe version.");
  const ops: AnimationOp[] = [{ anchor: recipe.anchor, attached: recipe.attached, op: "attach" }];
  const tracks: [string, AnimationPose][] = [];
  if (recipe.default !== undefined) tracks.push([DEFAULT_CLIP_KEY, recipe.default]);
  for (const clip of Object.keys(recipe.animations).sort((left, right) =>
    left.localeCompare(right),
  ))
    tracks.push([clip, recipe.animations[clip] as AnimationPose]);
  for (const [clip, track] of tracks) {
    for (const frame of [...track.keyframes].sort((left, right) => left.time - right.time))
      ops.push({
        attachment: track.attachment,
        clip,
        op: "key",
        time: frame.time,
        transform: frame.transform,
      });
  }
  return { host: recipe.host, ops, version: 4 };
}

/** Reads a v4 op log, a v3 recipe or a v2 recipe. Fails closed on anything else: a log this
 * package cannot read is a log it must not silently rewrite. */
export function upgradeLog(value: unknown): AnimationLog {
  if (!isRecord(value)) throw new Error("An animation log must be a JSON object.");
  if (typeof value.host !== "string" || value.host.length === 0)
    throw new Error("An animation log names its host GLB.");
  if (value.version === 4) {
    if (!Array.isArray(value.ops) || value.ops.length === 0)
      throw new Error("An animation log needs at least one op.");
    return { host: value.host, ops: value.ops.map((entry) => op(entry)), version: 4 };
  }
  if (value.version === 3 || value.version === 2)
    return fromRecipe(migrateRecipe(value as unknown as Parameters<typeof migrateRecipe>[0]));
  throw new Error(`Unsupported animation log version '${String(value.version)}'.`);
}

/** The poses the log describes, replayed from the source. Poses are sorted per clip, so two
 * replays of one log are equal, and one replay of an upgraded v3 recipe equals its v3 tracks. */
export function replayOps(log: AnimationLog): ReplayResult {
  let anchor: AnchorInfo | undefined;
  let attached: string | undefined;
  const poses: Record<string, AnimationPose> = {};
  for (const entry of log.ops) {
    if (entry.op === "attach") {
      anchor = entry.anchor;
      attached = entry.attached;
      continue;
    }
    const keyed = upsertKeyframe(poses[entry.clip], {
      time: entry.time,
      transform: entry.transform,
    });
    poses[entry.clip] =
      entry.attachment === undefined
        ? keyed
        : { attachment: entry.attachment, keyframes: keyed.keyframes };
  }
  if (anchor === undefined || attached === undefined)
    throw new Error("An animation log starts with an attach op naming the prop and its bone.");
  return { anchor, attached, host: log.host, poses };
}

/** Whether a clip moves the prop off its bone. A clip the log never mentions keeps the prop on. */
export function attachedIn(posed: ReplayResult, clip: string): boolean {
  return posed.poses[clip]?.attachment !== "detached";
}

export function appendOp(log: AnimationLog, entry: AnimationOp): AnimationLog {
  return { host: log.host, ops: [...log.ops, entry], version: 4 };
}

/** `<model>.glb` → `<model>.anim.json`, beside the source the game loads. */
export function logPathFor(glbPath: string): string {
  const parsed = path.parse(path.resolve(glbPath));
  return path.join(parsed.dir, `${parsed.name}.anim.json`);
}

export async function readLog(file: string): Promise<AnimationLog> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read animation log ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return upgradeLog(JSON.parse(text) as unknown);
}

export async function writeLog(file: string, log: AnimationLog): Promise<void> {
  await writeFile(file, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}
