import { useUiState } from "@threenative/ui";
import { ITEMS } from "../items/Inventory.js";
import type { GameState } from "../state.js";

function itemLabel(itemId: string): string {
  return Object.values(ITEMS).find((item) => item.id === itemId)?.label ?? "none";
}

export function CharacterPanel() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  const health = state.health;
  const damage = state.damage;
  const equipped = state.equippedItem;
  const lastDamage = state.lastDamage;
  return (
    <aside className="pointer-events-none absolute right-6 top-5 w-52 border border-line bg-panel/90 p-3 text-[10px] uppercase tracking-[0.14em]">
      <div className="text-amber">character</div>
      <div className="mt-3 flex justify-between text-dim">
        <span>health</span>
        <span className="text-cyan">{Math.round(health)} / 100</span>
      </div>
      <div className="mt-1 h-1 bg-void">
        <i className="block h-full bg-cyan" style={{ width: `${Math.max(0, health)}%` }} />
      </div>
      <div className="mt-3 flex justify-between text-dim">
        <span>damage</span>
        <span className="text-text">{Math.round(damage)}</span>
      </div>
      <div className="mt-2 border-t border-line pt-2 text-dim">
        weapon <span className="text-text">{itemLabel(equipped)}</span>
      </div>
      <div className="mt-1 text-dim">last hit {Math.round(lastDamage)}</div>
    </aside>
  );
}
