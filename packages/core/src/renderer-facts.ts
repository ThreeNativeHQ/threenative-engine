/**
 * What a renderer is, asked in one place.
 *
 * The facade wraps either the owned C++ engine or upstream three, and four core subsystems used to
 * answer that by probing the renderer's own `info` object with `"engine" in info` — a fact spelled
 * in four files, so a rename in the engine's info table would have left them all reporting the wrong
 * backend with nothing failing. This is the one reader.
 *
 * `kind` is the wrapper's own label (`"webgpu"` for either backend: three's WebGPU renderer can run
 * a WebGL fallback behind it, which is `isWebGLFallbackRenderer`'s question, not this one).
 */
export interface IRendererFacts {
  /** The wrapper's backend label, as `OutputRenderer.kind` reports it. */
  readonly kind: string;
  /** Whether the owned engine is behind the facade, rather than upstream three. */
  readonly ownedEngine: boolean;
}

/** The renderer shape these facts are read from: a `kind` label and the raw three renderer. */
export interface IRendererFactSource {
  readonly kind?: string;
  readonly raw?: unknown;
}

/**
 * The facts about `renderer`, from its own `info` table.
 *
 * A renderer with no `info` at all, or one from upstream three, is not the owned engine. A test
 * double may pass nothing, which is the same answer.
 */
export function rendererFacts(renderer: IRendererFactSource | undefined): IRendererFacts {
  const info = (renderer?.raw as { info?: { engine?: unknown } } | undefined)?.info;
  return {
    kind: renderer?.kind ?? "unknown",
    ownedEngine: info !== undefined && info.engine !== undefined,
  };
}
