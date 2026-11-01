import { UiLayer } from "@threenative/ui";
import { Commands } from "./Commands.js";
import { Hud, Selection } from "./Hud.js";
import { Minimap } from "./Minimap.js";

/**
 * Everything the player sees that is not the battlefield, laid out as AstraCraft's command deck:
 * a top bar, the objective and rival panels, a quick bar, and the minimap, selection card and
 * command card along the bottom. The look is plain CSS in `src/style.css` under `.astra-hud`.
 *
 * One component, mounted twice by two entries that differ only in what else is on the page:
 * `src/main.ts` puts it beside the canvas on the web target, and `src/ui/main.tsx` is the whole
 * page the native web view loads. Keeping both entries pointed at this file is what makes "the
 * same UI on every target" a fact rather than an intention.
 */
export function GameUi() {
  return (
    <UiLayer>
      <div className="astra-hud">
        <Hud />
        <footer className="bottom-hud">
          <Minimap />
          <Selection />
          <Commands />
        </footer>
      </div>
    </UiLayer>
  );
}
