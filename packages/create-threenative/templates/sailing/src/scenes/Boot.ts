import { Scene, getPlatform, isMobile } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import type { Texture } from "three";
import { prepareEnvironmentSample } from "../render/environmentSetup.js";
import { loadShipModel } from "../render/props.js";
import { isWebGLFallbackRenderer } from "../render/quality.js";
import { loadSky } from "../render/sky.js";
import type { GameState } from "../state.js";
import { Sailing } from "./Sailing.js";

export class Boot extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState = Sailing.initialState;

  // The photograph and the hull are fetched here, in the one method a scene is allowed to await,
  // so that `Sailing.enter` stays synchronous. That is not only tidiness: a playtest runner asks
  // the registry what this game can report as soon as the start scene's `enter()` returns, and a
  // scene that awaited its own load would still have no entities registered at that moment — so
  // every scenario with a component assertion would abort on `runtime.components` before taking a
  // frame. Both fetches run together, or the ship's own load would reopen exactly that gap one
  // scene hop later: `Boot.enter()` calls `goto("sailing")` without awaiting it, so the registry
  // is read the instant `Boot.enter()` returns — not once `Sailing.enter()` eventually does. See
  // `loadSky` and `loadShipModel`.
  override async load(ctx: {
    readonly renderer?: Parameters<Sailing["enter"]>[0]["renderer"];
    readonly assets: {
      model<T>(path: string): Promise<T>;
      texture(path: string): Promise<Texture>;
    };
  }): Promise<void> {
    await Promise.all([loadSky(ctx.assets), loadShipModel(ctx.assets)]);
    if (ctx.renderer !== undefined)
      await prepareEnvironmentSample(ctx.renderer.raw, {
        web: getPlatform().runtime === "web",
        rendererKind: ctx.renderer.kind,
        webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
        mobile: isMobile(),
        software: ctx.renderer.softwareAdapter !== undefined,
      });
  }

  override enter(ctx: Parameters<Sailing["enter"]>[0]): void {
    void ctx.goto("sailing");
  }
}
