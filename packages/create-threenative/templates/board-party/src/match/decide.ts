// How a CPU answers a prompt: a flat list of nodes, each a guard and a weight. The walk takes the first
// node whose guard passes, and the weight is literally the percent chance of the intended answer, so
// 30 makes a cautious pawn and 70 a bold one with no new decision code.
// Reference: mario-party-1 `cpu-decision-walk` (src/3F5B0.c:29-112, percent helper src/4D770.c:146).
import type { Stream } from "../rng.js";

/** What a guard may read about the pawn that is deciding. */
export interface IView {
  readonly coins: number;
  /** The live star sits on the shortcut. */
  readonly starOnBranch: boolean;
}

export interface INode {
  readonly when: (view: IView) => boolean;
  /** Percent chance of the intended answer, 0 to 100. */
  readonly weight: number;
}

/** Take the shortcut? A pawn that can pay for the star and sees it on the shortcut almost always goes. */
export const JUNCTION_NODES: readonly INode[] = [
  { when: (view) => view.starOnBranch, weight: 90 },
  { when: (view) => view.coins >= 20, weight: 65 },
  { when: () => true, weight: 40 },
];

/** Buy the star? A pawn that holds the price does, every time. mario-party-1 `star-purchase` (price 20). */
export const STAR_NODES: readonly INode[] = [
  { when: (view) => view.coins >= 20, weight: 100 },
  { when: () => true, weight: 0 },
];

export function decide(nodes: readonly INode[], view: IView, rng: Stream): boolean {
  const node = nodes.find((candidate) => candidate.when(view));
  return node !== undefined && rng.percent() < node.weight;
}
