import { UiLayer } from "@threenative/ui";
import { Hud } from "./Hud.js";

/**
 * Everything the player sees that is not the scene: the clock, the gauges, the damage panel and
 * the banner. `src/main.ts` mounts it beside the canvas on the web target, and `src/ui/main.tsx`
 * is the whole page the native web view loads.
 */
export function GameUi() {
  return (
    <UiLayer>
      <Hud />
    </UiLayer>
  );
}
