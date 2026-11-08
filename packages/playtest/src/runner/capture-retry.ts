import { CaptureGuardError } from "../capture.js";
import { PRESENTATION_BOUND_MS } from "./shared.js";

/**
 * Retake a capture until it is not blank, or until `boundMs` has passed, then report the last
 * blank verdict. Waits `grace` before every retake so the page can present.
 *
 * A world can be some presents away from its first visible frame, and how many depends on the
 * machine: a restart builds a new render chain whose pipelines compile while the surface stays
 * clear. One fixed retake passes on a fast machine and fails on a slow one. Polling the surface
 * itself is a state check rather than a longer wait, and a surface still blank at the bound
 * fails closed.
 */
export async function retakeWhileBlank<T>(
  retake: () => Promise<T>,
  grace: () => Promise<void>,
  boundMs: number,
  now: () => number = Date.now,
): Promise<T> {
  const deadline = now() + boundMs;
  for (;;) {
    await grace();
    try {
      return await retake();
    } catch (error) {
      if (!(error instanceof CaptureGuardError) || now() >= deadline) throw error;
    }
  }
}

/**
 * The one capture path of every lane. Shoot once; when the frame is blank, wait `grace` and
 * retake until the surface shows something or `boundMs` passes, then fail closed with the last
 * blank verdict. `capture` receives `true` on a retake, for the browser lane's fallbacks that
 * only make sense once a first shot stands. Any error that is not a blank verdict is final: a
 * closed page or a dead device is not a world that has yet to present.
 */
export async function captureWithRetry<T>(
  capture: (retake: boolean) => Promise<T>,
  grace: () => Promise<void>,
  boundMs: number = PRESENTATION_BOUND_MS,
  now: () => number = Date.now,
): Promise<T> {
  try {
    return await capture(false);
  } catch (error) {
    if (!(error instanceof CaptureGuardError)) throw error;
    return retakeWhileBlank(() => capture(true), grace, boundMs, now);
  }
}
