// One 30 Hz update of the whole body: the state's own step, then the air supply, the blade and
// the checks every state shares. Everything the reference engine does per update happens here.
import { AIR_REFILL_SURFACE, AIR_SUPPLY, DROWN_DAMAGE } from "../tuning.js";
import { stepAir } from "./air.js";
import { stepBlade } from "./blade.js";
import type { IBody, IInput } from "./body.js";
import { die } from "./death.js";
import { stepCompress, stepGround } from "./ground.js";
import { stepClimb, stepHang } from "./hang.js";
import { stepPickup, tryPickup } from "./pickup.js";
import { stepSwim } from "./swim.js";

export function stepExplorer(body: IBody, input: IInput, tick: number): void {
  body.note = "";
  if (body.state === "dead") return;
  switch (body.state) {
    case "idle":
    case "walk":
    case "run":
    case "back":
      if (!tryPickup(body, input)) stepGround(body, input);
      break;
    case "compress":
      stepCompress(body, input);
      break;
    case "jump":
    case "fall":
      stepAir(body, input);
      break;
    case "hang":
    case "shimmy":
      stepHang(body, input);
      break;
    case "climb":
      stepClimb(body);
      break;
    case "pickup":
      stepPickup(body);
      break;
    case "surface":
    case "swim":
    case "glide":
    case "tread":
      stepSwim(body, input);
      break;
    default:
      break;
  }
  breathe(body);
  stepBlade(body, tick);
}

/**
 * Air: under water it drains one unit an update, and at nothing she drowns at five health an
 * update. At the surface it refills ten an update, and out of the water it is full again
 * (water-and-air card, control.c:951, :968, :32).
 */
function breathe(body: IBody): void {
  if (body.state === "dead") return;
  if (body.state === "swim" || body.state === "glide" || body.state === "tread") {
    if (body.air > 0) body.air -= 1;
    else {
      body.health = Math.max(0, body.health - DROWN_DAMAGE);
      body.note = "drowning";
      if (body.health <= 0) die(body, "drown");
    }
  } else if (body.state === "surface")
    body.air = Math.min(AIR_SUPPLY, body.air + AIR_REFILL_SURFACE);
  else body.air = AIR_SUPPLY;
}
