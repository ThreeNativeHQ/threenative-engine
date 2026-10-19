import { createCssUiRoot } from "@threenative/core/react-css";
import game, { closeInventory } from "./game.js";
import { Inventory } from "./ui/Inventory.js";

/**
 * The native entry: the host starts the default-exported game, and the HUD is React reconciled
 * against the native CSS engine. No react-dom, no `document`, no web view — `src/ui/Inventory.tsx`
 * and `src/ui/hud.css` are the same files the browser reference mounts.
 */
createCssUiRoot().render(<Inventory onClose={closeInventory} />);

export default game;
