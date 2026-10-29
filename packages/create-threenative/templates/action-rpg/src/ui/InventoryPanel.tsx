import { useUiState } from "@threenative/ui";
import { ITEMS } from "../items/Inventory.js";
import type { GameState } from "../state.js";

export function InventoryPanel() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  const slots = state.inventorySlots;
  const refused = state.inventoryFullRefused;
  const pending = state.pendingLoot;
  // A stack holds three potions, so four potions fill two slots — but the player owns one kind of
  // item, so the list shows one row per item with its total and the header counts the slots.
  const totals = new Map<string, number>();
  for (const slot of slots) totals.set(slot.itemId, (totals.get(slot.itemId) ?? 0) + slot.quantity);
  return (
    <aside className="pointer-events-none absolute bottom-6 right-6 w-64 border border-line bg-panel/90 p-3 text-[10px] uppercase tracking-[0.14em]">
      <div className="flex justify-between text-amber">
        <span>inventory</span>
        <span className="text-dim">{slots.length} / 6 slots</span>
      </div>
      <div id="inventory-items" className="mt-3 space-y-1 text-dim">
        {totals.size === 0 && <div>empty</div>}
        {[...totals].map(([itemId, quantity]) => (
          <div className="border-b border-line/60 pb-1 text-text" key={itemId}>
            {Object.values(ITEMS).find((item) => item.id === itemId)?.label ?? itemId} x{quantity}
          </div>
        ))}
      </div>
      {refused === 1 && (
        <div className="mt-2 border border-red px-2 py-1 text-red">
          bag full · loot stays on floor
        </div>
      )}
      {pending !== "" && <div className="mt-2 text-amber">waiting: {pending}</div>}
    </aside>
  );
}
