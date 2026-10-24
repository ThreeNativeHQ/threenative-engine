import { PNG } from "pngjs";
import type { Page } from "playwright";

import type { IPlaytestStartupCoverObservation } from "../protocol.js";

/** A channel step past this is a different picture, not compression noise or a moving bar. */
const CHANNEL_TOLERANCE = 48;
/** A frame differs when more than this share of its pixels moved: a black frame moves all of them. */
const DIFFERING_SHARE = 0.25;

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

/**
 * Compares every startup frame with the last one, which is the loading cover just before the
 * world shows. No frame reports `frames: 0`, which the evaluator fails as unobserved.
 */
export function compareStartupFrames(frames: readonly IStartupCoverFrame[]): IPlaytestStartupCoverObservation {
  const reference = frames.at(-1);
  if (reference === undefined) return { differing: [], frames: 0, reference: [0, 0, 0] };
  const differing: IPlaytestStartupCoverObservation["differing"] = [];
  for (const frame of frames) {
    const share = differingShare(frame, reference);
    if (share > DIFFERING_SHARE) differing.push({ mean: meanColour(frame), ms: Math.round(frame.ms), share: Number(share.toFixed(3)) });
  }
  return { differing, frames: frames.length, reference: meanColour(reference) };
}

export interface IStartupCoverRecorder {
  /**
   * Stops recording and compares the frames presented after navigation and before readiness.
   * `readyMs` is the runtime's own readiness stamp, in ms since navigation.
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
  await cdp.send("Page.startScreencast", { everyNthFrame: 1, format: "png", maxHeight: 36, maxWidth: 64 });
  return {
    async finish(readyMs) {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      const origin = await page.evaluate(() => performance.timeOrigin);
      const startup = frames
        .filter(({ epochMs }) => epochMs >= origin && epochMs < origin + readyMs)
        .map(({ epochMs, png }) => {
          const image = PNG.sync.read(png);
          return { data: image.data, height: image.height, ms: epochMs - origin, width: image.width };
        });
      return compareStartupFrames(startup);
    },
  };
}
