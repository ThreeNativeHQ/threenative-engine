import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Menu() {
  // Page UI the loading cover cannot hide waits for it to lift; the hint's fade starts then too.
  if (useUiState<GameState>()?.loaded !== true) return null;
  return (
    <div className="pointer-events-none absolute bottom-6 left-6 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm animate-hint-fade">
      WASD run · space jump (land and jump again: double, triple) · shift crouch, then space: back
      flip or long jump · in the air, shift pounds · X dives
    </div>
  );
}
