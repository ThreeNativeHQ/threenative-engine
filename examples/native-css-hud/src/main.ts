import { createElement } from "react";
import { createRoot } from "react-dom/client";
import game, { closeInventory } from "./game.js";
import { Inventory } from "./ui/Inventory.js";

/**
 * The browser reference: the same game, the same `Inventory`, the same `hud.css`.
 *
 * Only the mount differs from `native.tsx` — react-dom here, the native CSS host there — which is
 * the whole claim this fixture makes. The click is wired to the game's store on both sides, so the
 * browser page can be asserted exactly as the native one is.
 */
const overlay = document.getElementById("tn-ui");
if (overlay === null) throw new Error("Missing #tn-ui element.");
createRoot(overlay).render(createElement(Inventory, { onClose: closeInventory }));

void game.start().then(
  () => console.info(`TN_NATIVE_CSS_HUD_READY:${game.ctx?.renderer.kind ?? "unknown"}`),
  (error: unknown) => {
    console.error(
      `TN_NATIVE_CSS_HUD_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  },
);
