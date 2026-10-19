// Generated user source: the measured temporal-history rejection counter. It calls the resolve's own
// history-validity node once per display pixel and adds each answer into two words, so the fraction
// a report states cannot drift from the decision the resolve drew with. One compute reset runs first,
// in its own single-thread dispatch, so no group can read a partial sum; the copy back is asynchronous
// and one at a time, so the frame never blocks on it.
import { type BufferAttribute, Vector2 } from "three";
import {
  Fn,
  If,
  atomicAdd,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  uint,
  uniform,
  vec2,
} from "three/tsl";
import type { Node, Renderer } from "three/webgpu";
import type { TemporalDepthRejection } from "./temporalResolveDepth.js";

/**
 * One completed measurement: the frame that counted, its rejected share, the display pixels the
 * kernel actually visited, and how old the measurement now is.
 */
export interface ITemporalRejectionMeasurement {
  readonly frame: number;
  readonly fraction: number;
  /** The GPU's own visited count, so a fraction can be checked against the raster it came from. */
  readonly visited: number;
  readonly staleFrames: number;
}

export interface ITemporalRejectionCounter {
  /** Dispatch reset and count for `frame`, then request one readback if none is in flight. */
  sample(renderer: Renderer, frame: number, width: number, height: number): void;
  /** The latest completed measurement, or `undefined` while none has landed. Never consumed. */
  report(frame: number): ITemporalRejectionMeasurement | undefined;
  /** The latest completed measurement, handed out once so a chain sees each measurement once. */
  drain(): { frame: number; fraction: number } | undefined;
  /** Resolves once no copy is in flight, and rejects with the reason the newest one is absent. */
  settled(): Promise<void>;
  dispose(): void;
}

export function createTemporalRejectionCounter(
  rejection: TemporalDepthRejection,
): ITemporalRejectionCounter {
  // Word 0 counts rejected display pixels, word 1 counts the pixels visited. A word an atomic
  // touches is only writable by another atomic, so the reset stores rather than assigns.
  const counter = instancedArray(2, "uint").toAtomic();
  const size = uniform(new Vector2(1, 1));
  const reset = Fn(() => {
    atomicStore(counter.element(0), uint(0));
    atomicStore(counter.element(1), uint(0));
  })().compute(1);
  const count = Fn(() => {
    const pixel = instanceIndex.toVar();
    const column = float(pixel.mod(uint(size.x)));
    const row = float(pixel.div(uint(size.x)));
    const hasValidHistory = rejection
      .historyValidity(vec2(column.add(0.5), row.add(0.5)).div(size))
      .get("hasValidHistory") as Node<"float">;
    If(hasValidHistory.oneMinus().greaterThan(0.5), () => {
      atomicAdd(counter.element(0), uint(1));
    });
    atomicAdd(counter.element(1), uint(1));
  })();
  let dispatched: ReturnType<typeof count.compute> | undefined;
  let pixels = 0;
  let inFlight: Promise<void> | undefined;
  let latest: { frame: number; fraction: number; visited: number } | undefined;
  let unpublished = false;
  let failure: string | undefined;
  let disposed = false;
  const owners = new Set<Renderer & { deleteAttribute(attribute: BufferAttribute): unknown }>();
  function releaseStorage() {
    for (const renderer of owners) renderer.deleteAttribute(counter.value);
    owners.clear();
  }

  /** The newest measurement is withdrawn and the reason kept, so nothing stale stays claimable. */
  function absent(reason: string): void {
    latest = undefined;
    unpublished = false;
    failure = reason;
  }

  return {
    sample(renderer: Renderer, frame: number, width: number, height: number): void {
      if (disposed) return;
      if (!Number.isInteger(frame) || !Number.isInteger(width) || !Number.isInteger(height))
        throw new Error(
          `Temporal AA rejection counting needs whole numbers, got frame ${frame} at ${width}x${height}.`,
        );
      if (width < 1 || height < 1) return;
      if (typeof Reflect.get(renderer, "deleteAttribute") !== "function")
        throw new Error("Temporal rejection counting requires owned attribute disposal.");
      owners.add(renderer as Renderer & { deleteAttribute(attribute: BufferAttribute): unknown });
      // The dispatch size is part of the compute node, so a new display raster builds a new one over
      // the same counter rather than a new counter.
      if (pixels !== width * height) {
        dispatched?.dispose();
        pixels = width * height;
        size.value.set(width, height);
        dispatched = count.compute(pixels);
      }
      renderer.compute(reset);
      renderer.compute(dispatched as NonNullable<typeof dispatched>);
      if (inFlight !== undefined) return;
      const dispatchedFrame = frame;
      const expected = pixels;
      // A readback that never lands, or lands malformed, withdraws the measurement instead of
      // publishing a zero. The reason rides the settled diagnostic, so nothing claims a count.
      inFlight = Promise.resolve(renderer.getArrayBufferAsync(counter.value))
        .then((bytes: ArrayBuffer) => {
          if (disposed) return;
          const words = new Uint32Array(bytes);
          const rejected = words[0];
          const visited = words[1];
          if (rejected === undefined || visited === undefined) {
            absent(`Temporal AA rejection readback carried ${words.length} of 2 words.`);
            return;
          }
          if (visited !== expected) {
            absent(
              `Temporal AA rejection readback visited ${visited} of ${expected} display pixels.`,
            );
            return;
          }
          if (rejected > visited) {
            absent(`Temporal AA rejection readback rejected ${rejected} of ${visited} pixels.`);
            return;
          }
          const fraction = rejected / visited;
          if (!Number.isFinite(fraction)) {
            absent(`Temporal AA rejection readback reported ${fraction}.`);
            return;
          }
          failure = undefined;
          latest = { frame: dispatchedFrame, fraction, visited };
          unpublished = true;
        })
        .catch((error: unknown) => {
          if (disposed) return;
          absent(`Temporal AA rejection readback failed: ${String(error)}`);
        })
        .finally(() => {
          inFlight = undefined;
          if (disposed) releaseStorage();
        });
    },
    report(frame: number): ITemporalRejectionMeasurement | undefined {
      if (latest === undefined) return undefined;
      return { ...latest, staleFrames: frame - latest.frame };
    },
    drain(): { frame: number; fraction: number } | undefined {
      if (latest === undefined || unpublished === false) return undefined;
      unpublished = false;
      return latest;
    },
    async settled(): Promise<void> {
      await inFlight;
      if (failure !== undefined) throw new Error(failure);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      latest = undefined;
      unpublished = false;
      failure = undefined;
      reset.dispose();
      dispatched?.dispose();
      dispatched = undefined;
      pixels = 0;
      if (inFlight === undefined) releaseStorage();
    },
  };
}
