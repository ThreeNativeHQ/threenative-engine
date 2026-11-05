/** One cancellable stream lane per owner: opening a stream supersedes only that lane's previous one. */
export interface IStreamLanes<TLane extends string> {
  /** Opens a stream in `lane`, superseding the lane's previous stream; answers whether it is current. */
  open(lane: TLane): () => boolean;
  /** Invalidates whatever is still in flight in `lane`, without opening a stream of its own. */
  supersede(lane: TLane): void;
}

/**
 * Cancellation bookkeeping for async work a newer request of the same kind can supersede. Each lane
 * supersedes only itself: a prop drag restreams props against the terrain already on screen and must
 * not cancel the terrain update still building the mesh it is about to commit.
 */
export function createStreamLanes<TLane extends string>(): IStreamLanes<TLane> {
  const generations = new Map<TLane, number>();
  const supersede = (lane: TLane): number => {
    const generation = (generations.get(lane) ?? 0) + 1;
    generations.set(lane, generation);
    return generation;
  };
  return {
    open(lane) {
      const generation = supersede(lane);
      return () => generations.get(lane) === generation;
    },
    supersede(lane) {
      supersede(lane);
    },
  };
}
