import { PNG } from "pngjs";
import type { Page } from "playwright";

import type { IPlaytestStartupCoverObservation } from "../protocol.js";
import { waitFrames } from "./steps.js";

/** A channel step past this is a different picture, not compression noise or a moving bar. */
const CHANNEL_TOLERANCE = 48;
/** A frame differs when more than this share of its pixels moved: a black frame moves all of them. */
const DIFFERING_SHARE = 0.25;
/**
 * A frame between readiness and the first world frame shows page UI over the cover when more than
 * this share of its pixels left the cover for the colour they have in the world frame: a HUD the
 * page painted before the canvas lifted the cover. Half a percent is a 200 x 40 px pill at 720p.
 */
const UI_OVER_COVER_SHARE = 0.005;
/** Frames recorded past readiness, so the hand-off to the world is in the recording. */
const HANDOFF_FRAMES = 30;

export interface IStartupCoverFrame {
  /** Milliseconds since navigation. */
  ms: number;
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

function meanColour(frame: IStartupCoverFrame): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  const pixels = frame.width * frame.height;
  for (let i = 0; i < pixels; i += 1) {
    sum[0] += frame.data[i * 4] ?? 0;
    sum[1] += frame.data[i * 4 + 1] ?? 0;
    sum[2] += frame.data[i * 4 + 2] ?? 0;
  }
  return sum.map((value) => Math.round(value / Math.max(1, pixels))) as [number, number, number];
}

function differingShare(frame: IStartupCoverFrame, reference: IStartupCoverFrame): number {
  if (frame.width !== reference.width || frame.height !== reference.height) return 1;
  const pixels = frame.width * frame.height;
  let moved = 0;
  for (let i = 0; i < pixels; i += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      if (Math.abs((frame.data[i * 4 + channel] ?? 0) - (reference.data[i * 4 + channel] ?? 0)) > CHANNEL_TOLERANCE) {
        moved += 1;
        break;
      }
    }
  }
  return moved / Math.max(1, pixels);
}

/** Share of pixels that moved off the cover and now match the world frame within the tolerance. */
function uiShare(frame: IStartupCoverFrame, cover: IStartupCoverFrame, world: IStartupCoverFrame): number {
  if (frame.width !== cover.width || frame.width !== world.width || frame.height !== cover.height || frame.height !== world.height) return 0;
  const pixels = frame.width * frame.height;
  let ui = 0;
  for (let i = 0; i < pixels; i += 1) {
    let offCover = false;
    let onWorld = true;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = frame.data[i * 4 + channel] ?? 0;
      if (Math.abs(value - (cover.data[i * 4 + channel] ?? 0)) > CHANNEL_TOLERANCE) offCover = true;
      if (Math.abs(value - (world.data[i * 4 + channel] ?? 0)) > CHANNEL_TOLERANCE) onWorld = false;
    }
    if (offCover && onWorld) ui += 1;
  }
  return ui / Math.max(1, pixels);
}

/**
 * Compares every startup frame with the last one before readiness, which is the loading cover just
 * before the world shows. Frames from `readyMs` on are the hand-off: the first one that differs from
 * the cover is the world, and a frame before it that already shows the world's page UI (a HUD) over
 * the cover is listed in `uiOverCover`. No frame reports `frames: 0`, which the evaluator fails as
 * unobserved; no world frame after readiness leaves `worldMs` absent, which it fails too.
 */
export function compareStartupFrames(frames: readonly IStartupCoverFrame[], readyMs = Number.POSITIVE_INFINITY): IPlaytestStartupCoverObservation {
  const startup = frames.filter((frame) => frame.ms < readyMs);
  const handOff = frames.filter((frame) => frame.ms >= readyMs);
  const reference = startup.at(-1);
  if (reference === undefined) return { differing: [], frames: 0, reference: [0, 0, 0], uiOverCover: [] };
  const differing: IPlaytestStartupCoverObservation["differing"] = [];
  for (const frame of startup) {
    const share = differingShare(frame, reference);
    if (share > DIFFERING_SHARE) differing.push({ mean: meanColour(frame), ms: Math.round(frame.ms), share: Number(share.toFixed(3)) });
  }
  const observation: IPlaytestStartupCoverObservation = { differing, frames: startup.length, reference: meanColour(reference), uiOverCover: [] };
  if (!Number.isFinite(readyMs)) return observation;
  const worldIndex = handOff.findIndex((frame) => differingShare(frame, reference) > DIFFERING_SHARE);
  const world = handOff[worldIndex];
  if (world === undefined) return observation;
  observation.worldMs = Math.round(world.ms);
  for (const frame of handOff.slice(0, worldIndex)) {
    const share = uiShare(frame, reference, world);
    if (share > UI_OVER_COVER_SHARE) observation.uiOverCover.push({ ms: Math.round(frame.ms), share: Number(share.toFixed(4)) });
  }
  return observation;
}

export interface IStartupCoverRecorder {
  /**
   * Records the hand-off frames past readiness, then stops and compares the frames presented after
   * navigation. `readyMs` is the runtime's own readiness stamp, in ms since navigation.
   */
  finish(readyMs: number): Promise<IPlaytestStartupCoverObservation>;
}

/**
 * Records every compositor frame from before navigation, through Chromium's screencast at a
 * thumbnail size, so the comparison sees what the player saw and not what the engine meant to draw.
 */
export async function recordStartupCover(page: Page): Promise<IStartupCoverRecorder> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Array<{ epochMs: number; png: Buffer }> = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ epochMs: (metadata.timestamp ?? Date.now() / 1000) * 1000, png: Buffer.from(data, "base64") });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  // 128 x 72: a HUD pill is about 20 x 4 px here, where 64 x 36 left it a smudge of two rows.
  await cdp.send("Page.startScreencast", { everyNthFrame: 1, format: "png", maxHeight: 72, maxWidth: 128 });
  return {
    async finish(readyMs) {
      await waitFrames(page, HANDOFF_FRAMES).catch(() => undefined);
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      const origin = await page.evaluate(() => performance.timeOrigin);
      const startup = frames
        .filter(({ epochMs }) => epochMs >= origin)
        .map(({ epochMs, png }) => {
          const image = PNG.sync.read(png);
          return { data: image.data, height: image.height, ms: epochMs - origin, width: image.width };
        });
      return compareStartupFrames(startup, readyMs);
    },
  };
}
