/**
 * Card thinning — the foliage level reducer, for primitives a triangle simplifier must not touch
 * (PRD-458 §4, §5).
 *
 * A needle card is two triangles. A simplifier asked to cut its triangle count has two bad options
 * and no third: collapse a card (the alpha-tested silhouette is now the wrong shape) or drop a
 * triangle (a hole in the canopy). So the triangle reducer declines needle primitives, and the
 * earlier cook was therefore right to report `insufficient-reduction` for every tree. This reducer
 * works in the unit the geometry is actually authored in — the **card**, a connected component of
 * the index buffer — and spends it the way foliage is spent: by dropping whole cards, spread evenly
 * through the canopy, so the crown keeps its coverage while the triangle count falls.
 *
 * Two properties make the result worth shipping, and both are the reason this is not
 * `indices.filter((_, i) => i % 2 === 0)`:
 *
 * - **Stratified, not sampled.** Cards are bucketed into a deterministic 3D grid keyed by their
 *   centroid, and each occupied cell keeps at least one card at every level. Random thinning
 *   punches visible bald patches exactly where the cards were densest; index-order thinning keeps a
 *   contiguous block of the index buffer, which is one side of the tree. Grid buckets keep every
 *   region of the crown populated.
 * - **Deterministic.** Buckets are ordered by their integer cell key, cards within a bucket by a
 *   hash of their own centroid. The same input bytes always produce the same levels, which is what
 *   `determinism.spec.ts` and a cache keyed on a generation fingerprint both depend on.
 *
 * **Scaled, so the crown stays covered.** Each kept card is scaled about its centroid by
 * `sqrt(lod0Area / keptArea)`, so the survivors cover the area the dropped cards did. Un-scaled, a
 * level's card area falls to the keep ratio, and on Machinefall the mid-distance pines read as bare
 * trunks (PRD-541). `TN_discrete_lod` stays index-only: a level's scaled cards are *copies* appended
 * to the primitive's own vertex arrays (see {@link ICardCopies}), and the level's indices point at
 * them. LOD0's indices never reference a copy, so a stock loader draws LOD0 unchanged, and both
 * runtime readers already build a level by copying the base attributes and swapping the index buffer.
 */

/**
 * The largest component still treated as a card.
 *
 * A two-triangle quad is the common case and four-to-eight-triangle cards (a bent, a folded, a
 * low-poly cluster) are ordinary. Anything larger is a shell or a trunk fan, where dropping a
 * component would delete a silhouette, so the primitive is left to the triangle reducer.
 */
const MAX_CARD_TRIANGLES = 8;

/**
 * How much of LOD0's cards each derived level keeps.
 *
 * Halving per level, capped by the policy's `maxLevels`. Read as "keep half the cards, then a
 * quarter", which is a *geometric* ladder of the crown's density rather than a triangle-ratio
 * ladder, and it is what the runtime's error-driven selection then chooses between.
 */
export const CARD_KEEP_RATIOS: readonly number[] = [0.5, 0.25];

const TRIANGLE = 3;

/**
 * The largest scale a kept card takes. Above it, a card grows past the crown's own silhouette; the
 * terminal level, which keeps far fewer cards than this restores, then covers `keep * 4` of LOD0.
 */
const MAX_CARD_SCALE = 2;

/** One card: the triangles of one connected component, its centroid and its area. */
export interface ICard {
  /** Indices into the primitive's index buffer, one entry per triangle of this card. */
  readonly triangles: readonly number[];
  readonly area: number;
  readonly centroid: readonly [number, number, number];
}

/** What one derived level kept, and what it cost the crown. Reported, never inferred. */
export interface ICardLevelSummary {
  /** Kept card area after scaling, as a fraction of LOD0's total card area. */
  readonly areaCoverage: number;
  readonly cards: number;
  /** Fraction of LOD0's occupied grid cells that still hold at least one kept card. */
  readonly cellCoverage: number;
  /** The fraction of LOD0's cards this level kept. */
  readonly keep: number;
  /** The factor every kept card was scaled by about its centroid; `1` keeps it as authored. */
  readonly scale: number;
}

/**
 * One level's scaled cards, appended after the primitive's vertices (and any earlier level's copies)
 * in level order. Copy `i` repeats every attribute of LOD0 vertex `source[i]`, except its position,
 * which is `positions[3i..3i+2]`.
 */
export interface ICardCopies {
  readonly positions: Float32Array;
  readonly source: Uint32Array;
}

/** A card-thinned chain, shaped like the triangle chain so both take the same attachment path. */
export interface ICardChain {
  readonly absoluteErrors: readonly number[];
  /** Per derived level, aligned with `counts`: the scaled copies its indices point at. */
  readonly copies: readonly ICardCopies[];
  readonly counts: readonly number[];
  readonly errors: readonly number[];
  readonly indices: readonly Uint32Array[];
  /** Per derived level, aligned with `counts`. */
  readonly levels: readonly ICardLevelSummary[];
  readonly lod0Cards: number;
  readonly lod0Triangles: number;
}

/** Reducible cards and triangles retained unchanged. */
interface ICardSet {
  readonly cards: ICard[];
  /**
   * Triangle start offsets of components larger than {@link MAX_CARD_TRIANGLES}. They are not cards,
   * so they cannot be scaled or dropped; every derived level keeps them verbatim beside the cards.
   */
  readonly preserved: readonly number[];
}

/**
 * Connected components of the index buffer, or `null` when the primitive has no thinable card.
 *
 * Union-find over shared vertices, which is the only cheap definition of "card" that does not need a
 * per-export convention: an exporter that duplicates the four corners of every quad, one that
 * shares a stem vertex, and a folded card all decompose the same way. A component larger than
 * {@link MAX_CARD_TRIANGLES} is a shell or a trunk fan, not a card: it is collected into
 * {@link ICardSet.preserved} rather than aborting the whole primitive, so one such component cannot
 * veto the thousands of eligible cards beside it. `null` means there is no eligible card at all, and
 * the caller keeps the primitive's existing behaviour.
 */
function findCards(positions: Float32Array, indices: Uint32Array): ICardSet | null {
  const vertexCount = Math.floor(positions.length / 3);
  const parent = new Int32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) parent[vertex] = vertex;
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root] as number;
    let walk = start;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (let triangle = 0; triangle + 2 < indices.length; triangle += TRIANGLE) {
    const a = find(indices[triangle] as number);
    const b = find(indices[triangle + 1] as number);
    const c = find(indices[triangle + 2] as number);
    if (a === c) continue;
    // Union by lower root: the order is fixed by the index buffer, so the tree is reproducible.
    const low = Math.min(a, b, c);
    for (const root of [a, b, c]) if (root !== low) parent[root] = low;
  }

  const grouped = new Map<number, number[]>();
  for (let triangle = 0; triangle + 2 < indices.length; triangle += TRIANGLE) {
    const root = find(indices[triangle] as number);
    const group = grouped.get(root);
    if (group === undefined) grouped.set(root, [triangle]);
    else group.push(triangle);
  }

  const cards: ICard[] = [];
  const preserved: number[] = [];
  for (const triangles of grouped.values()) {
    if (triangles.length === 0) continue;
    // Too large to be a card: keep every triangle, in index order, in every level.
    if (triangles.length > MAX_CARD_TRIANGLES) {
      for (const triangle of triangles) preserved.push(triangle);
      continue;
    }
    let area = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let vertices = 0;
    // Cards are small and vertex sets are tiny, so the exact per-card vertex list is cheaper than a
    // set: a four-vertex card repeats at most three times.
    const seen = new Set<number>();
    for (const triangle of triangles) {
      for (let corner = 0; corner < TRIANGLE; corner += 1) {
        const vertex = indices[triangle + corner] as number;
        if (seen.has(vertex)) continue;
        seen.add(vertex);
        vertices += 1;
        sx += positions[vertex * 3] as number;
        sy += positions[vertex * 3 + 1] as number;
        sz += positions[vertex * 3 + 2] as number;
      }
      const a = (indices[triangle] as number) * 3;
      const b = (indices[triangle + 1] as number) * 3;
      const c = (indices[triangle + 2] as number) * 3;
      const ux = (positions[b] as number) - (positions[a] as number);
      const uy = (positions[b + 1] as number) - (positions[a + 1] as number);
      const uz = (positions[b + 2] as number) - (positions[a + 2] as number);
      const vx = (positions[c] as number) - (positions[a] as number);
      const vy = (positions[c + 1] as number) - (positions[a + 1] as number);
      const vz = (positions[c + 2] as number) - (positions[a + 2] as number);
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    }
    cards.push({
      area,
      centroid: vertices === 0 ? [0, 0, 0] : [sx / vertices, sy / vertices, sz / vertices],
      triangles,
    });
  }
  // No eligible card means no thinning: preserve the primitive's existing behaviour rather than
  // inventing a level from components this reducer may not touch.
  if (cards.length === 0) return null;
  preserved.sort((a, b) => a - b);
  return { cards, preserved };
}

/** The original index values of the listed triangles, copied verbatim to keep in every level. */
function preservedIndices(triangles: readonly number[], source: Uint32Array): Uint32Array {
  if (triangles.length === 0) return new Uint32Array(0);
  const out = new Uint32Array(triangles.length * TRIANGLE);
  let at = 0;
  for (const triangle of triangles)
    for (let corner = 0; corner < TRIANGLE; corner += 1, at += 1)
      out[at] = source[triangle + corner] as number;
  return out;
}

/** `cards` with the preserved triangles in front, so a level draws both from the same index buffer. */
function withPreserved(preserved: Uint32Array, cards: Uint32Array): Uint32Array {
  if (preserved.length === 0) return cards;
  const out = new Uint32Array(preserved.length + cards.length);
  out.set(preserved);
  out.set(cards, preserved.length);
  return out;
}

/**
 * A stable integer hash of a card's position, quantised to `quantum` so float noise cannot change
 * the key and re-order the bake. Avoids `Math.random`, whose sequence would make the artifact depend
 * on call order, and avoids the index order the grid exists to ignore.
 */
function positionKey(centroid: readonly [number, number, number], quantum: number): number {
  const q = (value: number): number => Math.round(value / quantum) | 0;
  let hash =
    (q(centroid[0]) * 73856093) ^ (q(centroid[1]) * 19349663) ^ (q(centroid[2]) * 83492791);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return (hash ^ (hash >>> 15)) | 0;
}

/** One card placed in the stratification grid, with the key its bucket and its rank are derived from. */
interface IPlacedCard {
  readonly card: ICard;
  readonly cell: number;
  readonly key: number;
  readonly first: number;
}

/**
 * Buckets cards into a deterministic grid whose cell is about one card wide, and returns the bucket
 * count. `diag / cbrt(cards)` is the cell that puts roughly one card in each cell of a filled
 * volume, and it stays sane for a flat canopy where a volume-based cell would collapse to zero.
 */
function placeCards(
  cards: readonly ICard[],
  cellSize: number,
): { placed: IPlacedCard[]; cells: number } {
  const placed: IPlacedCard[] = cards.map((card, index) => {
    const [x, y, z] = card.centroid;
    return {
      card,
      // One integer key per cell: the grid is a hash, not a sort order.
      cell:
        (Math.floor(x / cellSize) * 73856093) ^
        (Math.floor(y / cellSize) * 19349663) ^
        (Math.floor(z / cellSize) * 83492791),
      first: index,
      key: positionKey(card.centroid, cellSize / 32),
    };
  });
  return { cells: new Set(placed.map((entry) => entry.cell)).size, placed };
}

/**
 * Deterministic order of the cards in one bucket: cell key first, then the card's own position hash,
 * then its centroid and index as a total tie-break. Reproducible, and spread through each bucket
 * rather than clipped from one side of it.
 */
function orderPlaced(a: IPlacedCard, b: IPlacedCard): number {
  return (
    a.key - b.key ||
    a.card.centroid[0] - b.card.centroid[0] ||
    a.card.centroid[1] - b.card.centroid[1] ||
    a.card.centroid[2] - b.card.centroid[2] ||
    a.first - b.first
  );
}

/** The cards of `placed`, bucketed by cell and ordered deterministically within each bucket. */
function bucketsOf(placed: readonly IPlacedCard[]): {
  buckets: Map<number, IPlacedCard[]>;
  cells: number[];
} {
  const buckets = new Map<number, IPlacedCard[]>();
  for (const entry of placed) {
    const bucket = buckets.get(entry.cell);
    if (bucket === undefined) buckets.set(entry.cell, [entry]);
    else bucket.push(entry);
  }
  const cells = [...buckets.keys()].sort((a, b) => a - b);
  for (const cell of cells) (buckets.get(cell) as IPlacedCard[]).sort(orderPlaced);
  return { buckets, cells };
}

/**
 * One level of the card ladder: the cards kept at `keep`, concatenated in a deterministic order.
 *
 * At least one card survives in every occupied cell, so coverage is a property of the selection
 * rather than a hope about it. The returned `cellCoverage` is measured from the kept set anyway,
 * because a level that ships has to *report* the coverage it got.
 */
function thinLevel(
  placed: readonly IPlacedCard[],
  keep: number,
  lod0Area: number,
  lod0Cells: number,
): { cards: ICard[]; summary: ICardLevelSummary } {
  const { buckets, cells: order } = bucketsOf(placed);
  const kept: ICard[] = [];
  let area = 0;
  let cells = 0;
  for (const cell of order) {
    const bucket = buckets.get(cell) as IPlacedCard[];
    const survivors = Math.max(1, Math.min(bucket.length, Math.round(keep * bucket.length)));
    for (const entry of bucket.slice(0, survivors)) {
      kept.push(entry.card);
      area += entry.card.area;
    }
    cells += 1;
  }
  return {
    cards: kept,
    summary: {
      areaCoverage: lod0Area === 0 ? 1 : area / lod0Area,
      cards: kept.length,
      cellCoverage: lod0Cells === 0 ? 1 : cells / lod0Cells,
      keep,
      scale: 1,
    },
  };
}

/** The index buffer for a set of cards, in the order {@link thinLevel} produced them. */
function indicesOf(cards: readonly ICard[], source: Uint32Array): Uint32Array {
  let length = 0;
  for (const card of cards) length += card.triangles.length * TRIANGLE;
  const out = new Uint32Array(length);
  let at = 0;
  for (const card of cards)
    for (const triangle of card.triangles) {
      out[at] = source[triangle] as number;
      out[at + 1] = source[triangle + 1] as number;
      out[at + 2] = source[triangle + 2] as number;
      at += TRIANGLE;
    }
  return out;
}

/**
 * A level drawn from scaled copies of its cards: the copies, numbered from `base`, and the index
 * buffer over them in {@link indicesOf}'s order. The scale restores LOD0's card area, capped at
 * {@link MAX_CARD_SCALE}; a card's vertices belong to that card alone, so each is copied once.
 */
function scaledLevel(
  level: { readonly cards: readonly ICard[]; readonly summary: ICardLevelSummary },
  indices: Uint32Array,
  positions: Float32Array,
  base: number,
): { copies: ICardCopies; indices: Uint32Array; summary: ICardLevelSummary } {
  const covered = level.summary.areaCoverage;
  const scale = covered > 0 ? Math.min(MAX_CARD_SCALE, Math.sqrt(1 / covered)) : 1;
  const copyOf = new Map<number, number>();
  const source: number[] = [];
  const moved: number[] = [];
  const out = indicesOf(level.cards, indices);
  let at = 0;
  for (const card of level.cards) {
    const [cx, cy, cz] = card.centroid;
    for (let corner = 0; corner < card.triangles.length * TRIANGLE; corner += 1, at += 1) {
      const vertex = out[at] as number;
      let copy = copyOf.get(vertex);
      if (copy === undefined) {
        copy = base + source.length;
        copyOf.set(vertex, copy);
        source.push(vertex);
        moved.push(
          cx + ((positions[vertex * 3] as number) - cx) * scale,
          cy + ((positions[vertex * 3 + 1] as number) - cy) * scale,
          cz + ((positions[vertex * 3 + 2] as number) - cz) * scale,
        );
      }
      out[at] = copy;
    }
  }
  return {
    copies: { positions: Float32Array.from(moved), source: Uint32Array.from(source) },
    indices: out,
    summary: { ...level.summary, areaCoverage: Math.min(1, covered * scale * scale), scale },
  };
}

/** Triangles a card submits (one entry in `triangles` per triangle). */
function cardTriangles(card: ICard): number {
  return card.triangles.length;
}

/**
 * The terminal level: the coarsest crown the triangle target allows.
 *
 * The ladder's per-cell floor (`Math.max(1, ...)`) means no keep ratio can go below one card per
 * LOD0 cell, and a dense canopy therefore stalls well above the target. The terminal level is
 * allowed to merge LOD0 cells into a coarser grid: it keeps at least one card per *coarse* cell,
 * then spends what is left of the target on further cards within each cell. Every occupied coarse
 * region stays populated, the level is never empty, and the triangle count reaches the target.
 *
 * The caller subtracts preserved triangles from `target`; `null` means the cards cannot fit.
 *
 * Returns the level and the grid factor that reached it, so the caller can report the coarse cell
 * width as the level's error (see {@link generateCardChain}).
 */
function terminalCardLevel(
  cards: readonly ICard[],
  lod0Placed: readonly IPlacedCard[],
  lod0Cells: number,
  lod0Area: number,
  cellSize: number,
  target: number,
  previousTriangles: number,
): { cards: ICard[]; factor: number; summary: ICardLevelSummary } | null {
  if (target <= 0 || target >= previousTriangles) return null;
  let factor = 1;
  let { buckets, cells } = bucketsOf(lod0Placed);
  const baseTriangles = (): number =>
    cells.reduce(
      (total, cell) =>
        total + cardTriangles((buckets.get(cell) as IPlacedCard[])[0]?.card as ICard),
      0,
    );
  // Widen the grid until one card per occupied coarse cell fits, or only one cell remains.
  while (baseTriangles() > target && cells.length > 1) {
    factor *= 2;
    ({ buckets, cells } = bucketsOf(placeCards(cards, cellSize * factor).placed));
  }
  // Even one card cannot fit the remaining budget.
  if (baseTriangles() > target) return null;
  const kept: ICard[] = [];
  const keptSet = new Set<ICard>();
  let triangles = 0;
  for (const cell of cells) {
    const first = (buckets.get(cell) as IPlacedCard[])[0] as IPlacedCard;
    kept.push(first.card);
    keptSet.add(first.card);
    triangles += cardTriangles(first.card);
  }
  for (const cell of cells) {
    const bucket = buckets.get(cell) as IPlacedCard[];
    for (let index = 1; index < bucket.length; index += 1) {
      const card = (bucket[index] as IPlacedCard).card;
      const cost = cardTriangles(card);
      if (triangles + cost > target) continue;
      kept.push(card);
      keptSet.add(card);
      triangles += cost;
    }
  }
  if (kept.length === 0) return null;
  const covered = new Set<number>();
  for (const entry of lod0Placed) if (keptSet.has(entry.card)) covered.add(entry.cell);
  let area = 0;
  for (const card of kept) area += card.area;
  return {
    cards: kept,
    factor,
    summary: {
      areaCoverage: lod0Area === 0 ? 1 : area / lod0Area,
      cards: kept.length,
      cellCoverage: lod0Cells === 0 ? 1 : covered.size / lod0Cells,
      keep: kept.length / cards.length,
      scale: 1,
    },
  };
}

/**
 * Builds the card chain for one primitive, or `null` when it is not a card set or cannot save
 * enough to be worth a level.
 *
 * Every level is derived from LOD0, never from the previous level, exactly like the triangle chain:
 * the reported error is then relative to the authored canopy and one level's budget cannot disturb
 * another's. `minSaving` is the same gate the triangle chain uses — a level that does not earn its
 * place is not shipped for its own sake — and `scale` is the same local-space unit the chain's
 * `absoluteError = error * errorScale` contract expects.
 *
 * The reported error is `cellSize * (1 - keep)`: the width of the cell a dropped card leaves behind,
 * which is the distance from a kept card to the nearest surface the level no longer draws. It rises
 * as the level coarsens, which is the monotonicity the runtime's selection requires.
 *
 * `terminalTriangles`, when given, is the triangle ceiling of one extra terminal level past the
 * ratio ladder (see {@link terminalCardLevel}); it reaches below the ladder's per-cell floor. The
 * triangles of any preserved component are subtracted before the terminal's cards are budgeted, so
 * the level it adds keeps the whole primitive — cards plus preserved geometry — at or under it.
 *
 * A component too large to be a card is not a reason to abandon the primitive: it rides verbatim at
 * the front of every level's index buffer, so one weld-fused shell cannot veto the eligible cards
 * beside it. Only a primitive with no eligible card returns `null`.
 */
export function generateCardChain(
  positions: Float32Array,
  indices: Uint32Array,
  maxLevels: number,
  minSaving: number,
  scale: number,
  keepRatios: readonly number[] = CARD_KEEP_RATIOS,
  terminalTriangles?: number,
): ICardChain | null {
  const found = findCards(positions, indices);
  if (found === null) return null;
  const { cards } = found;
  // Components too large to thin, kept verbatim at the front of every level's index buffer.
  const preserved = preservedIndices(found.preserved, indices);
  const lod0Triangles = Math.floor(indices.length / TRIANGLE);
  if (lod0Triangles <= 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex + 2 < positions.length; vertex += 3) {
    const x = positions[vertex] as number;
    const y = positions[vertex + 1] as number;
    const z = positions[vertex + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const cellSize = Math.max(diagonal / Math.cbrt(cards.length), 1e-6);
  const { cells: lod0Cells, placed } = placeCards(cards, cellSize);
  const lod0Area = cards.reduce((total, card) => total + card.area, 0);

  const levels: ICardLevelSummary[] = [];
  const counts: number[] = [];
  const errors: number[] = [];
  const absoluteErrors: number[] = [];
  const buffers: Uint32Array[] = [];
  const copies: ICardCopies[] = [];
  // Where the next level's copies start: after LOD0's vertices and every earlier level's copies.
  let base = Math.floor(positions.length / 3);
  let previousTriangles = lod0Triangles;
  for (const keep of keepRatios.slice(0, Math.max(0, maxLevels - 1))) {
    if (levels.length >= Math.max(0, maxLevels - 1)) break;
    const level = thinLevel(placed, keep, lod0Area, lod0Cells);
    // Never empty: a level that drops the last card draws nothing at all.
    if (level.cards.length === 0 || level.cards.length === cards.length) continue;
    const cardIndices = indicesOf(level.cards, indices);
    const triangles = Math.floor((preserved.length + cardIndices.length) / TRIANGLE);
    if (triangles >= previousTriangles) continue;
    if ((previousTriangles - triangles) / previousTriangles < minSaving) continue;
    const absoluteError = cellSize * (1 - keep);
    const scaled = scaledLevel(level, indices, positions, base);
    base += scaled.copies.source.length;
    levels.push(scaled.summary);
    counts.push(triangles);
    absoluteErrors.push(absoluteError);
    errors.push(absoluteError / Math.max(scale, 1e-6));
    buffers.push(withPreserved(preserved, scaled.indices));
    copies.push(scaled.copies);
    previousTriangles = triangles;
  }
  if (levels.length === 0) return null;
  // One terminal level past the cap, exempt from the saving gate: the ladder's per-cell floor can
  // stall well above the target, and the far instance still needs a coarse step to reach. Its error
  // is the coarse cell width, always wider than any ratio level's, so the runtime's distance switch
  // lands outward from the last ratio level.
  if (terminalTriangles !== undefined && terminalTriangles < previousTriangles) {
    const terminal = terminalCardLevel(
      cards,
      placed,
      lod0Cells,
      lod0Area,
      cellSize,
      // Preserved geometry counts against both the target and the previous rung.
      terminalTriangles - Math.floor(preserved.length / TRIANGLE),
      previousTriangles - Math.floor(preserved.length / TRIANGLE),
    );
    if (terminal !== null) {
      const cardIndices = indicesOf(terminal.cards, indices);
      const triangles = Math.floor((preserved.length + cardIndices.length) / TRIANGLE);
      if (triangles > 0 && triangles < previousTriangles) {
        const absoluteError = cellSize * terminal.factor;
        const scaled = scaledLevel(terminal, indices, positions, base);
        base += scaled.copies.source.length;
        levels.push(scaled.summary);
        counts.push(triangles);
        absoluteErrors.push(absoluteError);
        errors.push(absoluteError / Math.max(scale, 1e-6));
        buffers.push(withPreserved(preserved, scaled.indices));
        copies.push(scaled.copies);
        previousTriangles = triangles;
      }
    }
  }
  return {
    absoluteErrors,
    copies,
    counts,
    errors,
    indices: buffers,
    levels,
    lod0Cards: cards.length,
    lod0Triangles,
  };
}
