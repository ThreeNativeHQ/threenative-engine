import type { IBody } from "./body.js";

/** She is dead: the state the HUD and the restart read. `cause` says why ("fall", "drown", "blade"). */
export function die(body: IBody, cause: string): void {
  body.health = 0;
  body.state = "dead";
  body.cause = cause;
  body.speed = 0;
  body.vy = 0;
  body.hang = undefined;
}
