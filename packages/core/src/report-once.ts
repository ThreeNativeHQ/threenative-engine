/**
 * A platform seam that cannot work says so once, and then stays quiet.
 *
 * A game asks for vibration every time a shot lands and reads `navigator.vibrate` on every frame of
 * a phone that has no motor; a wall of identical warnings is a log the author stops reading. The
 * marker is the contract (`TN_HAPTICS_UNSUPPORTED`, `TN_QUIT_UNSUPPORTED`), and it is reported on
 * the first call, once per game.
 */

const reported = new Set<string>();

/** Prints `marker: detail` through `console.warn` the first time `marker` is reported. */
export function reportMarkerOnce(marker: string, detail: string): void {
  if (reported.has(marker)) return;
  reported.add(marker);
  console.warn(`${marker}: ${detail}`);
}
