// The owned engine consumes verified TNPK entries, never browser loaders or network fallbacks.
import { audio } from "./core-audio.mjs";
export function createAssetLoader(options = {}) {
  if (Object.keys(options).some((key) => !["renderer", "basePath", "manifest", "sourcePath", "cache", "backgroundFill"].includes(key)))
    throw new Error("TN_NATIVE_ASSET_OPTIONS_UNSUPPORTED: this player accepts cooked package paths only");
  // core's fallback for a game without a manifest: the verbatim path, then `<sourcePath>/<path>`.
  const sourcePath = (options.sourcePath ?? "assets").replace(/^\/+|\/+$/g, "");
  const read = (kind, path) => {
    try {
      return [globalThis.tn.loadAsset(kind, path), "manifest"];
    } catch (error) {
      if (!sourcePath || !/TN_NATIVE_ASSET_MISSING/.test(String(error?.message))) throw error;
      try { return [globalThis.tn.loadAsset(kind, `${sourcePath}/${path.replace(/^\/+/, "")}`), "source"]; }
      catch { throw error; }
    }
  };
  const cache = new Map();
  const pending = new Set();
  const resolved = new Map();
  const progress = { requested: 0, settled: 0, requestedBytes: 0, settledBytes: 0,
    get pending() { return [...pending]; } };
  const load = (kind, path, copy = false) => {
    if (typeof path !== "string" || !path || path.includes("\0"))
      return Promise.reject(new Error("TN_NATIVE_ASSET_INVALID: expected a nonempty logical path"));
    const key = `${kind}:${path}`;
    if (!copy && cache.has(key)) return cache.get(key);
    progress.requested++;
    pending.add(path);
    const result = Promise.resolve().then(() => {
      const [record, via] = read(kind, path);
      progress.requestedBytes += record.bytes;
      progress.settledBytes += record.bytes;
      resolved.set(path, { url: record.url, via });
      // Audio is a Buffer entry of encoded bytes; the shared context decodes it, as three's AudioLoader does.
      return kind === "audio" ? audio.AudioContext.getContext().decodeAudioData(record.value) : record.value;
    }).finally(() => { pending.delete(path); progress.settled++; });
    if (!copy) cache.set(key, result);
    result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
    return result;
  };
  return {
    progress, resolved,
    model: (path) => load("model", path),
    async texture(path, settings) {
      const value = await load("texture", path, settings !== undefined);
      if (settings === undefined) return value;
        if (settings.anisotropy !== undefined) value.anisotropy = settings.anisotropy;
        value.colorSpace = settings.data === true ? "" : "srgb";
        if (settings.wrap !== undefined) value.wrapS = value.wrapT = settings.wrap;
        if (typeof settings.repeat === "number") value.repeat.setScalar(settings.repeat);
        else if (settings.repeat !== undefined) value.repeat.set(...settings.repeat);
      return value;
    },
    audio: (path) => load("audio", path),
    resolve: async (path) => [resolved.get(path)?.url ?? `tnpk:${path}`],
    release: (kind, path) => cache.delete(`${kind}:${path}`),
    clear() { cache.clear(); resolved.clear(); },
    // Final disposal releases decoder worker pools in core; the TNPK host owns no such pool.
    // Keep this idempotent contract separate from clear(), which empties the reusable cache.
    dispose() {},
    // core's disk cache (PRD-743) is web-only: a native game reads its installed package, so the report
    // says so and prefetch and the background fill have nothing to fetch. `cache: false` changes nothing here.
    get cache() {
      return { enabled: false, persisted: false, hits: 0, misses: 0, bytesOnDisk: 0, bytesTotal: 0, filling: false,
        backgroundFill: false, reason: "native host reads installed files", clear: async () => {} };
    },
    prefetch: async () => ({ requested: 0, requestedBytes: 0, settled: 0, settledBytes: 0 }),
    startBackgroundFill: async () => {},
  };
}
