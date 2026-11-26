// The board, as data: a flat array of space records plus chain tables. A chain is a run of space
// indices, and a pawn's place is a cursor of (chain, slot), so a space becomes world coordinates in two
// steps. Retyping a space is one store on its record, which is how a plain space becomes the live star.
// Reference: mario-party-1 `board-space-graph` (src/engine/spaces.c:72-113) and `board-chain-cursor`.

export type SpaceType = "start" | "blue" | "red" | "star" | "used";
export type BaseType = "start" | "blue" | "red";

export interface ISpace {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** What the space is when no star marks it. */
  readonly base: BaseType;
  /** What the space is now: `base`, or `star` / `used` while the star rotation marks it. */
  type: SpaceType;
}

export interface ICursor {
  readonly chain: number;
  readonly slot: number;
}

export interface IChain {
  readonly ids: readonly number[];
  /** Where the walk goes after the last slot. A chain with no `then` wraps to its own slot 0. */
  readonly then?: ICursor;
}

/** Metres between neighbouring spaces. The card's 5 world units per grid unit is its own scale. */
const SPACING = 3;
/** The ring, clockwise from the top left: S start, B blue (+3 coins), R red (-3 coins). 24 spaces. */
const RING = "SBBBBBRBBRBBBRBBBBRBBBRB";
/** The shortcut across the middle, top to bottom: blue, red, blue. */
const CUT = "BRB";

const TYPE: Readonly<Record<string, BaseType>> = { S: "start", B: "blue", R: "red" };

/** A fresh space array. Each scene entry builds its own, so a restart starts clean. */
export function createSpaces(): ISpace[] {
  const points: [number, number][] = [];
  for (let i = 0; i < 9; i += 1) points.push([-12 + SPACING * i, -6]);
  for (let i = 0; i < 3; i += 1) points.push([12, -3 + SPACING * i]);
  for (let i = 0; i < 9; i += 1) points.push([12 - SPACING * i, 6]);
  for (let i = 0; i < 3; i += 1) points.push([-12, 3 - SPACING * i]);
  for (let i = 0; i < 3; i += 1) points.push([0, -3 + SPACING * i]);
  return points.map(([x, z], id) => {
    const base = TYPE[(RING + CUT)[id] as string] as BaseType;
    return { id, x, z, base, type: base };
  });
}

/** Chain 0 is the ring. Chain 1 is the shortcut, and it rejoins the ring at the bottom middle. */
export const CHAINS: readonly IChain[] = [
  { ids: Array.from({ length: 24 }, (_, i) => i) },
  { ids: [24, 25, 26], then: { chain: 0, slot: 16 } },
];

/**
 * The one junction: leaving the top middle space, the pawn may take the shortcut. A yes rewrites the
 * lookahead to the head of the branch chain and leaves the current space alone.
 * mario-party-1 `junction-prompt` (src/overlays/ovl_3E_FirstMap/257020.c:144).
 */
export const JUNCTION = { space: 4, branch: { chain: 1, slot: 0 } satisfies ICursor } as const;

/** The space a cursor points at. */
export function spaceAt(cursor: ICursor): number {
  return (CHAINS[cursor.chain] as IChain).ids[cursor.slot] as number;
}

/**
 * The cursor one slot ahead, following the chain's `then` at its end. Seating a pawn points its
 * lookahead one slot ahead. mario-party-1 `board-chain-cursor` (src/4D770.c:332).
 */
export function lookahead(cursor: ICursor): ICursor {
  const chain = CHAINS[cursor.chain] as IChain;
  const slot = cursor.slot + 1;
  if (slot < chain.ids.length) return { chain: cursor.chain, slot };
  return chain.then ?? { chain: cursor.chain, slot: 0 };
}

/** The cursor that looks ahead to `id`, for the playtest stations. */
export function cursorBefore(id: number): ICursor {
  for (const [chain, { ids }] of CHAINS.entries())
    for (let slot = 0; slot < ids.length; slot += 1)
      if (spaceAt(lookahead({ chain, slot })) === id) return { chain, slot };
  throw new Error(`No cursor looks ahead to space ${id}.`);
}

/**
 * The star's candidate spaces and their priority. A higher priority migrates toward the front of the
 * shuffle, so the ring is likelier than the shortcut. Seven candidates: mario-party-1 `star-space-rotation`
 * (src/overlays/ovl_36_DKsJungleAdventure/2418D0.c:40).
 */
export const STAR_CANDIDATES: readonly { readonly id: number; readonly priority: number }[] = [
  { id: 2, priority: 3 },
  { id: 8, priority: 2 },
  { id: 11, priority: 3 },
  { id: 14, priority: 2 },
  { id: 19, priority: 3 },
  { id: 22, priority: 1 },
  { id: 25, priority: 1 },
];
