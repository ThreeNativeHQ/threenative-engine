/**
 * What the UI asked for, waiting for the scene to read it.
 *
 * `game.ui.onIntent` fires outside any scene, so the listener only files the request here and the
 * scene drains it once a frame, inside the fixed step, where changing the match is safe.
 */
const pending: string[] = [];

export function pushIntent(intent: string): void {
  pending.push(intent);
}

export function drainIntents(): string[] {
  return pending.splice(0);
}
