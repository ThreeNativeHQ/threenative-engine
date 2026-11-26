import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/**
 * One published field. Each component reads only the fields it draws, so a frame that changes the
 * magazine re-renders the ammo panel and nothing else. `undefined` until the first snapshot.
 */
export function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}
