import type { IGame } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { DebugOverlay, GameCanvas } from "@threenative/ui";
import type { GameState } from "../state.js";
import { GameUi } from "./GameUi.js";

export function App({ game }: { game: IGame<GameState, IPhysicsContext> }) {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-ink">
      <GameCanvas className="absolute inset-0" game={game} />
      <GameUi />
      <DebugOverlay />
    </main>
  );
}
