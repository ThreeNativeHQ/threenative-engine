import { sampleHeight } from "./math.js";
import { applyOperation, createState, finalizeState } from "./operations.js";
import type {
  ICopyRegionOptions,
  IEvaluateOptions,
  IMask,
  ITerrainConfig,
  ITerrainDocument,
  ITerrainState,
  Layer,
  LayerParams,
  OperationType,
} from "./types.js";
import { RESOLUTIONS, validateConfig, validateDocument, validateLayer } from "./validation.js";

export type OperationOptions<T extends OperationType> = LayerParams[T] & {
  id?: string;
  label?: string;
  enabled?: boolean;
  opacity?: number;
  mask?: IMask;
};
export type LayerPatch = {
  type?: OperationType;
  name?: string;
  enabled?: boolean;
  opacity?: number;
  mask?: IMask | null;
  params?: Partial<LayerParams[OperationType]>;
};
export type PatchCommand =
  | { op: "upsert"; layer: Layer }
  | { op: "update"; id: string; patch: LayerPatch }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; index: number }
  | { op: "toggle"; id: string; enabled?: boolean };

/**
 * Recovered prefix-caching authoring evaluator. Returned buffers belong to the caller.
 * @requires npm i @threenative/terrain
 * @situation reuse terrain evaluation prefixes while authoring a finite heightfield
 * @constraint evaluates authoring documents only; games consume pre-baked arrays
 * @example const terrain = new Terrain({ resolution: 17 }); const evaluator = new TerrainEvaluator(); const state = evaluator.evaluate(terrain.toJSON());
 * @override cacheMB bounds retained prefix data
 */
export class TerrainEvaluator {
  private cache = new Map<string, { state: ITerrainState; bytes: number }>();
  private bytes = 0;
  private limit: number;
  constructor({ cacheMB = 48 } = {}) {
    if (!Number.isFinite(cacheMB) || cacheMB < 0)
      throw new RangeError("cacheMB must be finite and nonnegative");
    this.limit = cacheMB * 1024 * 1024;
  }
  clear() {
    this.cache.clear();
    this.bytes = 0;
  }
  evaluate(
    doc: ITerrainDocument,
    { resolution = doc.config.resolution, signal, onProgress }: IEvaluateOptions = {},
  ): ITerrainState {
    validateDocument(doc);
    validateConfig({ ...doc.config, resolution });
    const keys: string[] = [];
    let key = JSON.stringify({ ...doc.config, resolution });
    for (const layer of doc.layers) {
      key += `|${JSON.stringify(layer)}`;
      keys.push(key);
    }
    let state: ITerrainState | undefined;
    let start = 0;
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i] as string;
      const hit = this.cache.get(k);
      if (hit) {
        state = structuredClone(hit.state);
        start = i + 1;
        this.cache.delete(k);
        this.cache.set(k, hit);
        break;
      }
    }
    state ??= createState(doc.config, resolution);
    for (let i = start; i < doc.layers.length; i++) {
      signal?.throwIfAborted();
      const layer = doc.layers[i] as Layer;
      applyOperation(state, layer);
      onProgress?.({ index: i, total: doc.layers.length, id: layer.id });
      const bytes =
        state.height.byteLength +
        state.splat.byteLength +
        Object.values(state.erosion ?? {}).reduce((n, a) => n + a.byteLength, 0) +
        Object.values(state.biomes).reduce((n, a) => n + a.byteLength, 0);
      if (bytes <= this.limit) {
        while (this.bytes + bytes > this.limit && this.cache.size) {
          const first = this.cache.entries().next().value;
          if (!first) break;
          this.bytes -= first[1].bytes;
          this.cache.delete(first[0]);
        }
        this.cache.set(keys[i] as string, { state: structuredClone(state), bytes });
        this.bytes += bytes;
      }
    }
    signal?.throwIfAborted();
    if (!state.height.every(Number.isFinite))
      throw new Error("A terrain operation produced a non-finite height");
    return finalizeState(state);
  }
}

/**
 * Ordered, stable-ID terrain authoring with synchronous atomic transactions.
 * @requires npm i @threenative/terrain
 * @situation author seeded terrain with noise, sculpting, erosion, roads, rivers and scatter
 * @situation generate a procedural heightmap landscape or island for a game
 * @constraint authoring stays outside the game's steady-play graph; no renderer or physics is created
 * @constraint units are metres with Y up; `size` is the world edge in metres (1 to 100000), centred on the origin
 * @constraint `resolution` counts vertices per edge and must be one of 17, 33, 65, 129, 257, 513 or 1025
 * @constraint `seed` is an integer from 0 to 4294967295; one document and seed evaluate to the same arrays
 * @constraint `evaluate()` is synchronous on the calling thread: run it in a build script, never per frame
 * @constraint no art is chosen or shipped: materials, models and texture paths belong to the game
 * @example const terrain = new Terrain({ size: 512, resolution: 257, seed: 73 }).noise({ id: "hills", amplitude: 35 });
 * @override size, resolution, seed and all layer parameters are caller choices
 */
export class Terrain {
  private _doc: ITerrainDocument;
  private _undo: ITerrainDocument[] = [];
  private _redo: ITerrainDocument[] = [];
  private _listeners = new Set<(terrain: Terrain) => void>();
  private _historyLimit: number;
  private _transactionDepth = 0;
  private _evaluator = new TerrainEvaluator();
  constructor({
    size = 512,
    resolution = 257,
    seed = 73,
    historyLimit = 60,
  }: Partial<ITerrainConfig> & { historyLimit?: number } = {}) {
    const config = { size, resolution, seed };
    validateConfig(config);
    if (!Number.isInteger(historyLimit) || historyLimit < 0)
      throw new RangeError("historyLimit must be a nonnegative integer");
    this._doc = { version: 1, config, layers: [] };
    this._historyLimit = historyLimit;
  }
  static fromJSON(json: string | ITerrainDocument): Terrain {
    const doc: ITerrainDocument =
      typeof json === "string" ? JSON.parse(json) : structuredClone(json);
    validateDocument(doc);
    const terrain = new Terrain(doc.config);
    terrain._doc = doc;
    return terrain;
  }
  get layers() {
    return structuredClone(this._doc.layers);
  }
  get config() {
    return structuredClone(this._doc.config);
  }
  get canUndo() {
    return this._undo.length > 0;
  }
  get canRedo() {
    return this._redo.length > 0;
  }
  toJSON() {
    return structuredClone(this._doc);
  }
  subscribe(fn: (terrain: Terrain) => void) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  private _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch (error) {
        console.error("Terrain subscriber failed:", error);
      }
    }
  }
  private _change(fn: () => void): this {
    const before = structuredClone(this._doc);
    try {
      fn();
      validateDocument(this._doc);
    } catch (error) {
      this._doc = before;
      throw error;
    }
    if (!this._transactionDepth) {
      this._undo.push(before);
      if (this._undo.length > this._historyLimit) this._undo.shift();
      this._redo = [];
      this._emit();
    }
    return this;
  }
  private _id(type: OperationType) {
    let i = 1;
    while (this._doc.layers.some((layer) => layer.id === `${type}-${i}`)) i++;
    return `${type}-${i}`;
  }
  add(layer: Layer): this {
    const next = { enabled: true, opacity: 1, ...structuredClone(layer) };
    next.id ??= this._id(next.type);
    validateLayer(next);
    return this._change(() => {
      const i = this._doc.layers.findIndex((layer) => layer.id === next.id);
      if (i < 0) this._doc.layers.push(next);
      else this._doc.layers[i] = next;
    });
  }
  private _operation<T extends OperationType>(type: T, options: OperationOptions<T>): this {
    const { id, label, enabled, opacity, mask, ...params } = options;
    if (
      "data" in params &&
      params.data &&
      typeof params.data === "object" &&
      "values" in params.data &&
      ArrayBuffer.isView(params.data.values)
    ) {
      const data = params.data as { width: number; height: number; values: Float32Array };
      Object.assign(params, { data: { ...data, values: Array.from(data.values) } });
    }
    const layer = { id: id ?? this._id(type), type, params } as Layer;
    const optional = Object.fromEntries(
      Object.entries({ name: label, enabled, opacity, mask }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    return this.add(Object.assign(layer, optional));
  }
  layer(id: string): Layer {
    const layer = this._doc.layers.find((layer) => layer.id === id);
    if (!layer) throw new Error(`Unknown layer '${id}'`);
    return structuredClone(layer);
  }
  update(id: string, patch: LayerPatch): this {
    const old = this.layer(id);
    const next = {
      ...old,
      ...structuredClone(patch),
      id,
      params: { ...old.params, ...structuredClone(patch.params ?? {}) },
    };
    const { mask: _mask, ...unmasked } = next;
    return this.add((patch.mask === null ? unmasked : next) as Layer);
  }
  toggle(id: string, enabled = this.layer(id).enabled === false) {
    return this.update(id, { enabled });
  }
  move(id: string, index: number): this {
    if (!Number.isInteger(index) || index < 0 || index >= this._doc.layers.length)
      throw new RangeError("Layer index out of bounds");
    return this._change(() => {
      const i = this._doc.layers.findIndex((layer) => layer.id === id);
      if (i < 0) throw new Error(`Unknown layer '${id}'`);
      const layer = this._doc.layers.splice(i, 1)[0] as Layer;
      this._doc.layers.splice(index, 0, layer);
    });
  }
  remove(id: string) {
    this.layer(id);
    return this._change(() => {
      this._doc.layers = this._doc.layers.filter((layer) => layer.id !== id);
    });
  }
  setConfig(patch: Partial<ITerrainConfig>) {
    const config = { ...this._doc.config, ...patch };
    validateConfig(config);
    return this._change(() => {
      this._doc.config = config;
    });
  }
  loadJSON(json: string | ITerrainDocument) {
    const next = Terrain.fromJSON(json).toJSON();
    return this._change(() => {
      this._doc = next;
    });
  }
  transaction(fn: (terrain: this) => unknown): this {
    if (fn.constructor.name === "AsyncFunction")
      throw new TypeError("Transactions must be synchronous");
    const before = structuredClone(this._doc);
    const undo = this._undo.slice();
    const redo = this._redo.slice();
    this._transactionDepth++;
    try {
      const result = fn(this);
      if (
        result &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      )
        throw new TypeError("Transactions must be synchronous");
      validateDocument(this._doc);
      this._transactionDepth--;
      if (!this._transactionDepth) {
        this._undo.push(before);
        if (this._undo.length > this._historyLimit) this._undo.shift();
        this._redo = [];
        this._emit();
      }
      return this;
    } catch (error) {
      this._transactionDepth--;
      this._doc = before;
      this._undo = undo;
      this._redo = redo;
      throw error;
    }
  }
  applyPatch(commands: readonly PatchCommand[]): this {
    return this.transaction(() => {
      for (const command of commands) {
        switch (command.op) {
          case "upsert":
            this.add(command.layer);
            break;
          case "update":
            this.update(command.id, command.patch);
            break;
          case "remove":
            this.remove(command.id);
            break;
          case "move":
            this.move(command.id, command.index);
            break;
          case "toggle":
            this.toggle(command.id, command.enabled);
            break;
          default:
            throw new Error("Unknown patch command");
        }
      }
    });
  }
  undo(): this {
    const prior = this._undo.pop();
    if (prior) {
      this._redo.push(structuredClone(this._doc));
      this._doc = prior;
      this._emit();
    }
    return this;
  }
  redo(): this {
    const next = this._redo.pop();
    if (next) {
      this._undo.push(structuredClone(this._doc));
      this._doc = next;
      this._emit();
    }
    return this;
  }
  evaluate(options?: IEvaluateOptions) {
    return this._evaluator.evaluate(this._doc, options);
  }
  clearCache() {
    this._evaluator.clear();
  }
  copyRegion({ at = [0, 0], size = 64, resolution = 33 }: ICopyRegionOptions = {}) {
    if (!RESOLUTIONS.includes(resolution)) throw new RangeError("Unsupported copy resolution");
    if (!(size > 0 && Number.isFinite(size))) throw new RangeError("Copy size must be positive");
    const state = this.evaluate();
    const values: number[] = [];
    for (let z = 0; z < resolution; z++)
      for (let x = 0; x < resolution; x++)
        values.push(
          sampleHeight(
            state,
            at[0] + (x / (resolution - 1) - 0.5) * size,
            at[1] + (z / (resolution - 1) - 0.5) * size,
          ),
        );
    return { width: resolution, height: resolution, values };
  }
  inspect(options?: IEvaluateOptions) {
    const state = this.evaluate(options);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const height of state.height) {
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
    return {
      size: state.size,
      resolution: state.resolution,
      layers: this._doc.layers.length,
      vertices: state.height.length,
      triangles: 2 * (state.resolution - 1) ** 2,
      minHeight: min,
      maxHeight: max,
      instances: state.instances.length,
      diagnostics: state.diagnostics,
    };
  }

  noise(options: OperationOptions<"noise"> = {}): this {
    return this._operation("noise", options);
  }
  sculpt(options: OperationOptions<"sculpt"> = {}): this {
    return this._operation("sculpt", options);
  }
  smooth(options: OperationOptions<"smooth"> = {}): this {
    return this._operation("smooth", options);
  }
  flatten(options: OperationOptions<"flatten"> = {}): this {
    return this._operation("flatten", options);
  }
  ramp(options: OperationOptions<"ramp">): this {
    return this._operation("ramp", options);
  }
  stamp(options: OperationOptions<"stamp"> = {}): this {
    return this._operation("stamp", options);
  }
  erode(options: OperationOptions<"erode"> = {}): this {
    return this._operation("erode", options);
  }
  terrace(options: OperationOptions<"terrace"> = {}): this {
    return this._operation("terrace", options);
  }
  materials(options: OperationOptions<"materials">): this {
    return this._operation("materials", options);
  }
  paint(options: OperationOptions<"paint"> = {}): this {
    return this._operation("paint", options);
  }
  biome(options: OperationOptions<"biome"> = {}): this {
    return this._operation("biome", options);
  }
  scatter(options: OperationOptions<"scatter"> = {}): this {
    return this._operation("scatter", options);
  }
  clear(options: OperationOptions<"clear">): this {
    return this._operation("clear", options);
  }
  road(options: OperationOptions<"road">): this {
    return this._operation("road", options);
  }
  river(options: OperationOptions<"river">): this {
    return this._operation("river", options);
  }
  water(options: OperationOptions<"water"> = {}): this {
    return this._operation("water", options);
  }
  heightmap(options: OperationOptions<"heightmap">): this {
    return this._operation("heightmap", options);
  }
  paste(options: OperationOptions<"paste">): this {
    return this._operation("paste", options);
  }
}
