import { UiLayer } from "@threenative/ui";
import { Hud } from "./Hud.js";
import { Menu } from "./Menu.js";

/**
 * Everything the player sees that is not the scene.
 *
 * One component, mounted twice by two entries that differ only in what else is on the page:
 * `src/main.ts` puts it beside the canvas on the web target, and `src/ui/main.tsx` is the whole
 * page the native web view loads. Keeping both entries pointed at this file is what makes "the
 * same UI on every target" a fact rather than an intention.
 */
export function GameUi() {
  return (
    <UiLayer>
      <Hud />
      <Menu />
    </UiLayer>
  );
}
