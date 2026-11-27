import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
export function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

/** A list of text lines with keys that stay unique when two lines repeat. */
export function keyed(lines: readonly string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    return { key: `${line}#${count}`, line };
  });
}
