import { createCssUiRoot } from "@threenative/core/react-css";
import game, { closeInventory } from "../../src/game.js";
import { Panel } from "./ui/Panel.js";

// Same game and same intent as the Tailwind arm; only the styling pipeline differs.
createCssUiRoot().render(<Panel onClose={closeInventory} />);

export default game;
