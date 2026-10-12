/**
 * The probe's read-back for a host that draws after the frame callback returns (the engine player). Its
 * `tn.readFrame()` answers with the last frame the player DREW, and inside the callback that stepped frame N
 * that is frame N-1: the probe picture lagged the web arm's, which re-renders frame N into a target, by one
 * step of every cube's rotation. Waiting one frame callback lets the player draw frame N first, and nothing
 * steps the scene in between.
 */
export function drawnFrameReader<T>(
  nextFrame: () => Promise<unknown>,
  read: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    await nextFrame();
    return read();
  };
}
