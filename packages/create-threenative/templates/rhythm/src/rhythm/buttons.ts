/**
 * The six answer buttons. One table feeds the input map in `game.ts`, the chart in `chart.ts` and
 * the prompts in `ui/`, so a button is named in one place. `pad` holds W3C standard-mapping
 * indices: 12 to 15 are the d-pad, 0 is the south face button and 1 the east one.
 */
export const BUTTONS = [
  { name: "left", action: "pressLeft", keys: ["ArrowLeft"], pad: [14], glyph: "←", hint: "Left" },
  { name: "up", action: "pressUp", keys: ["ArrowUp"], pad: [12], glyph: "↑", hint: "Up" },
  {
    name: "right",
    action: "pressRight",
    keys: ["ArrowRight"],
    pad: [15],
    glyph: "→",
    hint: "Right",
  },
  { name: "down", action: "pressDown", keys: ["ArrowDown"], pad: [13], glyph: "↓", hint: "Down" },
  { name: "z", action: "pressZ", keys: ["KeyZ"], pad: [0], glyph: "Z", hint: "Z / A" },
  { name: "x", action: "pressX", keys: ["KeyX"], pad: [1], glyph: "X", hint: "X / B" },
] as const;

export type ButtonName = (typeof BUTTONS)[number]["name"];
