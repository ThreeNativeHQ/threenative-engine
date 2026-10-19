/**
 * One-shot actions from the HUD. Sliders and toggles are state; these are verbs, so the UI pushes
 * them here and the scene drains the queue on its next fixed step — the same functions a key
 * press calls, so the keyboard and the panel can never disagree.
 */
export type Command = "reset" | "drop" | "kick" | "view" | "auto" | "blizzard" | "mute";

export const commands: Command[] = [];
