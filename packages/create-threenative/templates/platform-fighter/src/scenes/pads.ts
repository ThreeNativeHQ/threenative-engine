import type { InputMap } from "@threenative/core";
import type { Pad } from "../sim/types.js";

/** The keyboard (or the pad) as one frame of fighter intent. */
export function readPad(input: InputMap): Pad {
  const move = input.vector("move");
  const held = (name: string): boolean => input.pressed(name) || input.justPressed(name);
  return {
    attack: held("attack"),
    dodge: held("dodge"),
    jump: held("jump"),
    shield: held("shield"),
    strong: held("strong"),
    x: move.x,
    y: move.y,
  };
}
