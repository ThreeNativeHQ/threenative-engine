import type { SlotView } from "../state.js";
import { useField } from "./useField.js";

const CASE_SLOTS = 6;

function Slots({
  slots,
  size,
  cursor,
  active,
}: {
  slots: readonly SlotView[];
  size: number;
  cursor: number;
  active: boolean;
}) {
  const rows = Array.from({ length: Math.max(size, slots.length) }, (_, index) => slots[index]);
  return (
    <ol className="flex flex-col gap-1">
      {rows.map((slot, index) => (
        <li
          // A slot's place is its identity: the case is a grid, not a list of items.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots, the index is the slot
          key={index}
          className={`flex h-9 w-64 items-center justify-between rounded border px-3 text-sm ${
            active && index === cursor
              ? "border-cyan bg-cyan/25 text-text"
              : "border-line bg-black/50 text-text"
          }`}
        >
          <span>{slot?.label ?? "—"}</span>
          {slot !== undefined && slot.quantity > 1 && <span>{slot.quantity}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The case (I) and the item box: the world stops while either is open, as it always did. */
export function CaseScreen() {
  const menu = useField("menu");
  const slots = useField("slots") ?? [];
  const stored = useField("box") ?? [];
  const cursor = useField("cursor") ?? 0;
  const column = useField("column");
  const message = useField("message") ?? "";
  const magazine = useField("magazine") ?? 0;
  if (menu !== "inventory" && menu !== "box") return null;
  const box = menu === "box";
  return (
    <section
      id={box ? "item-box" : "inventory"}
      className="absolute inset-0 flex items-center justify-center gap-10 bg-black/75 text-text"
    >
      <div>
        <h2 className="mb-3 text-xs uppercase tracking-[0.3em] text-text">
          Case · {slots.length} / {CASE_SLOTS} · loaded {magazine}
        </h2>
        <Slots slots={slots} size={CASE_SLOTS} cursor={cursor} active={!box || column === "case"} />
      </div>
      {box && (
        <div>
          <h2 className="mb-3 text-xs uppercase tracking-[0.3em] text-text">Item box</h2>
          <Slots
            slots={stored}
            size={Math.max(6, stored.length)}
            cursor={cursor}
            active={column === "box"}
          />
        </div>
      )}
      {message !== "" && (
        <p id="case-message" className="absolute bottom-20 rounded bg-black/80 px-5 py-2 text-sm">
          {message}
        </p>
      )}
      <p className="absolute bottom-10 text-xs uppercase tracking-[0.2em] text-text">
        {box
          ? "W/S choose · A/D case or box · E move · I close"
          : "W/S choose · E use · C combine · I close"}
      </p>
    </section>
  );
}
