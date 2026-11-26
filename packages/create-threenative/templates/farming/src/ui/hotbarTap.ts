// A tap on a hotbar slot, handed from the HUD to the scene. A touch screen has no number keys.
let tapped: number | undefined;

export const hotbarTap = {
  push(index: number): void {
    tapped = index;
  },
  /** The slot tapped since the last call, once. */
  take(): number | undefined {
    const index = tapped;
    tapped = undefined;
    return index;
  },
};
