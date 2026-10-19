import type { IAudioPassOptions } from "./passes/audio-config.js";
import type { ILightmapPassOptions } from "./passes/lightmap.js";
import type { IModelPassOptions } from "./passes/model.js";
import type { ITexturePassOptions, ITextureResizeOptions } from "./passes/texture.js";

/**
 * The serialisable description of the built-in pass registry, rebuilt inside each worker.
 *
 * Only the built-in registry crosses a worker boundary: a caller-supplied `IAssetPass` is an
 * arbitrary closure carrying whatever state its author gave it, and none of that is
 * transferable. A compile with custom passes therefore runs sequential, by design, and the
 * result says so (`concurrencyUsed`).
 */
export type PassSpec =
  | {
      readonly kind: "audio";
      readonly needsRuntimeDecoder: boolean;
      readonly options: IAudioPassOptions;
    }
  /** No options: the pass is decided entirely by the input's extension. */
  | { readonly kind: "blender-import"; readonly needsRuntimeDecoder: boolean }
  | {
      readonly kind: "lightmap";
      readonly astc?: boolean;
      readonly needsRuntimeDecoder: boolean;
      readonly options: ILightmapPassOptions;
    }
  | {
      readonly kind: "model";
      readonly needsRuntimeDecoder: boolean;
      /** `sharedImages` arrives as a flag; the worker builds the store against its output root. */
      readonly options: Omit<IModelPassOptions, "sharedImages"> & {
        readonly sharedImages?: boolean;
      };
    }
  | {
      readonly kind: "texture";
      readonly needsRuntimeDecoder: boolean;
      readonly options?: ITexturePassOptions;
    }
  /** Decoder-free resize of a standalone texture, used where the KTX2 pass cannot ship. */
  | {
      readonly kind: "texture-resize";
      readonly needsRuntimeDecoder: false;
      readonly options: ITextureResizeOptions;
    };

/** One input's job, posted from the driver to a worker. */
export interface IWorkerJob {
  readonly id: number;
  readonly input: Buffer;
  /** Given to the worker so a shared-image store built there writes into the same output root. */
  readonly logical: string;
  readonly outputRoot: string;
}

/** What one job's reply carries: the applied chain, cloned as plain views over the wire. */
export interface WorkerApplied {
  readonly auxiliaryOutputs: readonly {
    readonly buffer: Uint8Array;
    readonly extension: string;
    readonly manifestField: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly outputPath?: string;
    readonly role: string;
  }[];
  readonly buffer: Uint8Array;
  readonly entry: Record<string, unknown> | undefined;
  readonly extension: string | undefined;
  readonly timings: readonly { readonly durationMs: number; readonly name: string }[];
}

/** The worker's reply for one job: the applied chain, or the failure that stopped it. */
export type IWorkerReply =
  | { readonly applied: WorkerApplied; readonly id: number }
  | { readonly error: string; readonly id: number };

/** The bootstrap message: the specs every job of this pool runs, sent once. */
export interface IWorkerBootstrap {
  readonly outputRoot: string;
  readonly specs: readonly PassSpec[];
}
