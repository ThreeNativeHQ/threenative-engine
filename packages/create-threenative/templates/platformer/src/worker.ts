import { serveWorkerGame } from "@threenative/core/worker";
import game from "./game.js";

// The worker side of `index.html`: the same portable game, on its own thread.
serveWorkerGame(game);
