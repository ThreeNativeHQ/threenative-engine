import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
export function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}
