import { Scene } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import type { GameState } from "../state.js";
import { Snow } from "./Snow.js";

export class Boot extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState = Snow.initialState;

  override enter(ctx: Parameters<Snow["enter"]>[0]): void {
    void ctx.goto("snow");
  }
}
