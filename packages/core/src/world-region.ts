import type { IHeightfieldRegionBounds } from "./world.js";

/** The smallest window covering both; `current` may be absent. Internal to the world modules. */
export function unionBounds(
  current: IHeightfieldRegionBounds | undefined,
  next: IHeightfieldRegionBounds,
): IHeightfieldRegionBounds {
  if (current === undefined) return next;
  const column = Math.min(current.column, next.column);
  const row = Math.min(current.row, next.row);
  return {
    column,
    columns: Math.max(current.column + current.columns, next.column + next.columns) - column,
    row,
    rows: Math.max(current.row + current.rows, next.row + next.rows) - row,
  };
}
