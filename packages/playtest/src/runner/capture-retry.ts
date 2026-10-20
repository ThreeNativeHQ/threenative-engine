import { CaptureGuardError } from "../capture.js";

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
