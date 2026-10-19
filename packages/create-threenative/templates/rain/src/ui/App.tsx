import type { IGame } from "@threenative/core";
import { DebugOverlay, GameCanvas } from "@threenative/ui";
import { useEffect } from "react";
import type { GameState } from "../state.js";
import { GameUi } from "./GameUi.js";
import { installTempest } from "./tempest.js";

/**
 * The study's page: the engine's canvas, and the interface from `./GameUi.js` over it.
 *
 * No physics context on the generic, because `game.ts` is `defineGame<GameState>` — a coastal
 * weather study moves the air, not a rigid body. The UI is mounted from `src/main.ts`, so the
 * canvas and the overlay share one root and one React tree.
 *
 * The automation facade is installed here rather than in `game.ts` because `window.tempest` and
 * the query it reads are the UI realm's; the game module stays portable code.
 */
export function App({ game }: { game: IGame<GameState> }) {
  useEffect(() => {
    installTempest(game);
  }, [game]);
  return (
    <main className="canvas-root">
      <GameCanvas className="canvas-fill" game={game} />
      <GameUi />
      <DebugOverlay />
    </main>
  );
}
