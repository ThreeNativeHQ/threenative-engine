import { UiLayer } from "@threenative/ui";
import { CaseScreen } from "./CaseScreen.js";
import { Hud } from "./Hud.js";
import { Screens } from "./Screens.js";

/**
 * Everything the player sees that is not the scene. Mounted by `src/main.ts` beside the canvas on
 * the web, and as the whole page by `src/ui/main.tsx` in the native web view.
 */
export function GameUi() {
  return (
    <UiLayer>
      <Hud />
      <CaseScreen />
      <Screens />
    </UiLayer>
  );
}
