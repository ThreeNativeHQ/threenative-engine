import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { type IAssetCompileOptions, compileAssets } from "./compile.js";
import type { IPassCostRow } from "./report.js";

/**
 * Dev-mode compilation: watches the asset source directory and recompiles into the output
 * directory, so the dev loop is not "rebuild to see a texture".
 *
 * A settled burst runs `compileAssets` over the whole project — the same call the build lane
 * makes, once per burst rather than once per changed file. The compiler's cache is what makes
 * that affordable: an input whose bytes and pass configuration are unchanged is a hit and is
 * never re-encoded, so a save pays for the file that changed. It is also the only way the output
 * root stays honest, because nothing that matters here is per-file. One cook writes the manifest,
 * the receipt naming every file it owns, the shared images several models point at and the Basis
 * runtime the KTX2 loader fetches for them; it deletes the outputs the previous receipt owned and
 * this one does not; and it measures the byte budget across the project, which is the only scale
 * a ceiling means anything at. Cooking one file in isolation can produce a file but never a
 * project: it publishes an entry without the images underneath it, orphans yesterday's output in
 * `public/` the moment a save renames it, and clears a whole-game budget by weighing one asset.
 *
 * The price is that a burst fails closed. One compile means a broken file fails the burst, so a
 * good file saved beside it is not published either. That is the compiler's own contract — a pass
 * failure stops the build with the asset path — and the safe direction here: the last good cook
 * keeps serving, the named failure goes to stderr, and the next good save heals it.
 *
 * Watcher mechanism: `node:fs.watch({ recursive: true })` — deliberately neither chokidar nor
 * Vite's own server watcher. This package is Node-only with zero runtime dependencies; Vite's
 * watcher exists only inside a Vite process and would drag in a peer dependency, and chokidar
 * adds a package outright. Recursive `fs.watch` covers Windows, macOS and Linux on the Node
 * versions Vite already requires, keeps `watchAssets` usable outside a dev server, and leaves
 * the template plugin a handful of lines that only start and stop this watcher.
 */

export interface IAssetWatchSummary {
  readonly compiled: readonly string[];
  readonly failed: readonly string[];
  /**
   * One cost row per pass for this burst's compile, the same records a build emits. Present only
   * when the burst compiled something; a burst compiles the whole project, so an input the cache
   * skipped is counted in `cachedInputs` rather than left out.
   */
  readonly passCosts?: readonly IPassCostRow[];
}

export interface IAssetWatchOptions extends IAssetCompileOptions {
  /** Quiet window that coalesces a burst of saves into one recompile. Default 100 ms. */
  readonly debounceMs?: number;
  /** Called once per settled burst with the logical paths that compiled and that failed. */
  readonly onChange?: (summary: IAssetWatchSummary) => void;
}

export interface IAssetWatchHandle {
  /**
   * Settles once the initial full compile finished. An initial failure is logged to stderr
   * instead of thrown — a broken asset must not keep a dev server from booting, fixing the file
   * triggers a healing burst, and the build lane still fails closed through `compileAssets`.
   */
  readonly ready: Promise<void>;
  /** Stops watching and cancels any pending debounced burst. Idempotent. */
  close(): void;
}

const DEFAULT_SOURCE = "assets";
const DEFAULT_DEBOUNCE_MS = 100;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function watchAssets(options: IAssetWatchOptions = {}): IAssetWatchHandle {
  const { debounceMs, onChange, ...compileOverrides } = options;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  // Every option but the two watch-only ones is the compiler's and is forwarded whole, so a dev
  // loop cooking for a platform or under a concurrency bound cooks exactly what its build does.
  // A dev loop is a web page, and absent decoders means the default web engine's, which decodes
  // neither KTX2 nor Meshopt: a pre-0.3.5 vite config names none and must still cook loadable
  // models. `threenative build` cooks the same for a game that names no engine.
  const compileOptions: IAssetCompileOptions = {
    ...compileOverrides,
    runtimeDecoders: compileOverrides.runtimeDecoders ?? { ktx2: false, meshopt: false },
    cwd,
  };
  // Resolution only. compileAssets validates the layout it is handed — unknown config keys, a
  // source that overlaps its output — on every call below, including the first one.
  const sourceRoot = path.resolve(cwd, options.source ?? options.config?.source ?? DEFAULT_SOURCE);
  const debounce = debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const logFailure = (message: string): void => {
    process.stderr.write(`TN_ASSETS_WATCH_FAILED: ${message}\n`);
  };

  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> = Promise.resolve();
  let closed = false;
  const queue = new Set<string>();

  const armDebounce = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runFlush();
    }, debounce);
  };

  const queueEvent = (filename: string): void => {
    const logical = filename.split(path.sep).join("/").replace(/^\.\//u, "");
    if (logical.length === 0 || logical.split("/").some((segment) => segment.startsWith("."))) {
      return;
    }
    void stat(path.join(sourceRoot, logical)).then(
      (info) => {
        if (!info.isFile()) return; // directories announce their children separately
        queue.add(logical);
        armDebounce();
      },
      () => {
        // A vanished file is not a path to compile, and needs no special handling beyond running
        // the burst: the cook owns the output root and reconciles the deletion by rewriting it.
        queue.delete(logical);
        armDebounce();
      },
    );
  };

  const reportBurst = (
    compiled: readonly string[],
    failed: readonly string[],
    passCosts: readonly IPassCostRow[],
  ): void => {
    if (onChange === undefined || (compiled.length === 0 && failed.length === 0)) return;
    try {
      onChange({ compiled, failed, ...(compiled.length > 0 ? { passCosts } : {}) });
    } catch (error) {
      logFailure(`onChange listener threw: ${messageOf(error)}`);
    }
  };

  const flush = async (batch: readonly string[]): Promise<void> => {
    try {
      const result = await compileAssets(compileOptions);
      // The receipt names the source of every file the cook owns, so a saved path it excluded —
      // or one deleted again before the burst settled — is not announced as compiled.
      const cooked = new Set(
        (result.receipt?.outputs ?? []).flatMap((output) =>
          output.source === null ? [] : [output.source],
        ),
      );
      reportBurst(
        batch.filter((logical) => cooked.has(logical)),
        [],
        result.passCosts,
      );
    } catch (error) {
      // Nothing was published: the previous manifest, receipt and outputs still serve the game.
      // The paths this burst touched are reported, the compiler's error names the asset, and the
      // next good save heals it.
      const scope = batch.length === 0 ? "reconcile" : batch.join(", ");
      logFailure(`burst failed (${scope}): ${messageOf(error)}`);
      reportBurst([], batch, []);
    }
  };

  const runFlush = (): void => {
    const batch = [...queue].sort();
    queue.clear();
    flushing = flushing.then(async () => {
      if (closed) return;
      try {
        await flush(batch);
      } catch (error) {
        logFailure(`burst failed: ${messageOf(error)}`);
      }
    });
  };

  const startWatching = (): void => {
    try {
      watcher = watch(sourceRoot, { recursive: true }, (_eventType, filename) => {
        if (closed) return;
        if (typeof filename !== "string" || filename.length === 0) {
          armDebounce(); // an unnamed event: reconcile the project rather than guess at a path
          return;
        }
        queueEvent(filename);
      });
    } catch {
      // No assets/ directory yet is the documented pre-pipeline state: stay inert until restart.
      return;
    }
    watcher.on("error", (error) => {
      logFailure(messageOf(error));
      armDebounce();
    });
  };

  const ready = (async () => {
    try {
      await compileAssets(compileOptions);
    } catch (error) {
      logFailure(`initial compile failed: ${messageOf(error)}`);
    }
    if (!closed) startWatching();
  })();

  return {
    ready,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}
