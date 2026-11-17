/**
 * Paint each placed tree's crown into a per-vertex canopy grid, so the ground under a stand reads as
 * forest floor rather than open turf. `values` is row-major Z then X, centred on the origin, at the
 * heightfield's own spacing; each vertex keeps the strongest crown that reaches it (0 to 1).
 * @situation shade the ground under a baked stand, at bake time or after a placement edit
 * @constraint `crowns` is metres of crown radius per unit of placement scale, keyed by asset; other assets paint nothing
 * @requires npm i -D @threenative/terrain
 * @example paintCanopyCover(values, { size: 512, resolution: 257 }, placements, { spruce: 7 });
 */
export function paintCanopyCover(
  values: Float32Array,
  world: { readonly size: number; readonly resolution: number },
  placements: readonly {
    readonly asset: string;
    readonly position: readonly number[];
    readonly scale: number;
  }[],
  crowns: Readonly<Record<string, number>>,
): void {
  if (world.resolution < 2) return;
  if (values.length !== world.resolution ** 2)
    throw new RangeError(
      `paintCanopyCover: ${values.length} values do not fill a ${world.resolution}² grid`,
    );
  const spacing = world.size / (world.resolution - 1);
  for (const placement of placements) {
    const crown = crowns[placement.asset];
    if (crown === undefined) continue;
    const radius = Math.max(spacing, crown * placement.scale);
    paintCrown(values, world, placement.position[0] ?? 0, placement.position[2] ?? 0, radius);
  }
}

/** One crown's falloff, `1 - d²/r²`, kept where it beats what the grid already holds. */
function paintCrown(
  values: Float32Array,
  world: { readonly size: number; readonly resolution: number },
  x: number,
  z: number,
  radius: number,
): void {
  const spacing = world.size / (world.resolution - 1);
  const half = world.size / 2;
  const last = world.resolution - 1;
  const fromColumn = Math.max(0, Math.ceil((x - radius + half) / spacing));
  const toColumn = Math.min(last, Math.floor((x + radius + half) / spacing));
  const fromRow = Math.max(0, Math.ceil((z - radius + half) / spacing));
  const toRow = Math.min(last, Math.floor((z + radius + half) / spacing));
  for (let row = fromRow; row <= toRow; row++)
    for (let column = fromColumn; column <= toColumn; column++) {
      const dx = column * spacing - half - x;
      const dz = row * spacing - half - z;
      const reach = 1 - (dx * dx + dz * dz) / (radius * radius);
      if (reach <= 0) continue;
      const index = row * world.resolution + column;
      values[index] = Math.max(values[index] as number, reach);
    }
}
