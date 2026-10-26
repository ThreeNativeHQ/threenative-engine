import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

// The controls card sits in the top-right corner, where the follow camera never puts Wren (she
// stands in the lower middle of the frame). `scenes/Play.ts` checks that against `HINT`.
export function Menu() {
  // Page UI the loading cover cannot hide waits for it to lift.
  if (useUiState<GameState>()?.loaded !== true) return null;
  return (
    <ul className="pointer-events-none absolute right-6 top-6 w-72 space-y-0.5 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm">
      <li>WASD run · mouse look</li>
      <li>click slash · right-click shield</li>
      <li>Tab lock on · space roll · E open</li>
    </ul>
  );
}
