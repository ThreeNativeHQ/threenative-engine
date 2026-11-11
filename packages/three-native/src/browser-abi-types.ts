import type { TypedArray } from "./browser-marshal.js";
/**
 * The engine's C ABI as the browser back end sees it (PRD-532, PRD-803): the runtime interface the
 * classes call, the handle's packed words, the value layouts of `tn_abi.h`, and the two host
 * integrations a module may carry (the glTF loader and TSL by name).
 */
import type { ITslRuntime, TslArgValue } from "./browser-tsl.js";
import type { DebugTelemetry } from "./debug-telemetry.js";

/** A ref with its handle words kept (see `createWasmRuntime`): type | context << 16, index, generation. */
export interface IPackedRef extends IEngineRef {
  w0: number;
  w1: number;
  w2: number;
}

/**
 * The ref's handle words. A ref the runtime made carries them; any other ref is parsed once and keeps them, so
 * writing a handle is three stores and never a key parse per call.
 */
export function packedRef(ref: IEngineRef): IPackedRef {
  const known = ref as Partial<IPackedRef>;
  if (known.w0 !== undefined) return known as IPackedRef;
  const [type = 0, context = 0, index = 0, generation = 0] = ref.key.split(":").map(Number);
  const words = { w0: (type | (context << 16)) >>> 0, w1: index, w2: generation };
  return Object.isExtensible(ref) ? Object.assign(ref, words) : { ...ref, ...words };
}

/** An engine object as the back end sees it: an opaque key and its catalog type id. */
export interface IEngineRef {
  readonly key: string;
  readonly type: number;
}

export function isRef(value: unknown): value is IEngineRef {
  return typeof value === "object" && value !== null && "key" in value && "type" in value;
}

export type EngineValue =
  | null
  | undefined
  | number
  | boolean
  | string
  | TypedArray
  | readonly EngineValue[]
  | IEngineRef
  | { readonly [key: string]: EngineValue };

/** PRD-828: one rig of an animation tick batch, as the backend takes it. */
export interface IAnimationTickBatch {
  /** One entry per rig: the mixer, the rig's action (null when nothing plays), the body it strides from. */
  readonly mixers: readonly IEngineRef[];
  readonly actions: readonly (IEngineRef | null)[];
  readonly roots: readonly (IEngineRef | null)[];
  /**
   * Five per rig: the stride interval, this tick's own time, the clip's ground speed, the rate this rule
   * last applied (0 for none), and the flags word.
   */
  readonly values: Float64Array;
  /** Three per rig, written by the call: stride rate, measured ground speed, flags. */
  readonly status: Float64Array;
}

/** What the classes call; the Wasm ABI implements it, and a surface-only runtime refuses every call. */
export interface IBrowserRuntime {
  readonly debugTelemetry?: DebugTelemetry;
  typeId(className: string): number;
  construct(className: string, args: readonly EngineValue[]): IEngineRef;
  invoke(self: IEngineRef, method: string, args: readonly EngineValue[]): EngineValue;
  get(self: IEngineRef, path: string): EngineValue;
  set(self: IEngineRef, path: string, value: EngineValue): void;
  release(self: IEngineRef): void;
  /** For each ref, how many references other engine objects hold to its object; one call a batch. */
  engineReferences?(refs: readonly IEngineRef[]): ArrayLike<number>;
  /**
   * PRD-828: advances a batch of animation rigs in one crossing — the weight ramp, the stride rate and
   * one mixer step each. A backend that cannot batch leaves it out and the JS loop keeps running.
   */
  animTick?(batch: IAnimationTickBatch): void;
  /** A numeric typed array argument crosses as is, no boxed copy; Wasm only. */
  readonly typedArrays?: boolean;
  /** Doubles at `address` in the engine's memory (one as a number, more as an array); Wasm only. */
  readDoubles?(address: number, count: number): number | number[];
  /**
   * The engine's memory as doubles, current: Emscripten replaces the view when the memory grows, so a caller
   * reads it per operation and never keeps it. Wasm only.
   */
  heapF64?(): Float64Array;
  /** The byte at `address` in the engine's memory; Wasm only. A registry field `[offset, 0]` is a byte flag. */
  readByte?(address: number): number;
  /** The 32-bit word at `address` in the engine's memory (the hierarchy counter's low word); Wasm only. */
  readWord?(address: number): number;
  /** Writes one double at `address` in the engine's memory; Wasm only. */
  writeDouble?(address: number, value: number): void;
  /** Writes the byte at `address` in the engine's memory (a flag field); Wasm only. */
  writeByte?(address: number, value: number): void;
  /**
   * A copy of the attribute's data, of its scalar type; three's `attribute.array` is built on it.
   * With `offset`/`count`, a copy of that scalar subrange only (a per-vertex setter syncs one item).
   */
  attributeArray?(self: IEngineRef, offset?: number, count?: number): TypedArray;
  /**
   * Writes `array` into the attribute's data; present with attributeArray. With `offset`, writes that
   * subrange; without it, `array` must be the attribute's whole data.
   */
  attributeWrite?(self: IEngineRef, array: TypedArray, offset?: number): void;
  /** Sets (or, with null, clears) a callback the engine runs; `handler` gets the engine's arguments. */
  setCallback(
    self: IEngineRef,
    name: string,
    handler: ((args: readonly EngineValue[]) => void) | null,
  ): void;
  /** TSL by name (PRD-540), when the module carries `tn_tsl_call`. */
  readonly tsl?: ITslRuntime;
  /** A GLB through the engine's own glTF loader (PRD-540), when the module carries the web host. */
  loadGltf?(
    bytes: Uint8Array,
    files?: ReadonlyMap<string, Uint8Array>,
  ): {
    readonly scene: IEngineRef;
    readonly animations: IEngineRef[];
    /** Every scene in file order; the default scene is one of them. */
    readonly scenes: IEngineRef[];
  };
  /** `loadGltf` on the engine's loader thread (PRD-860), when the module carries it. */
  loadGltfAsync?(
    bytes: Uint8Array,
    files?: ReadonlyMap<string, Uint8Array>,
  ): Promise<{
    readonly scene: IEngineRef;
    readonly animations: IEngineRef[];
    /** Every scene in file order; the default scene is one of them. */
    readonly scenes: IEngineRef[];
  }>;
}

/**
 * The engine's C ABI as built by `tn-native-engine-abi-module` (Emscripten, wasm32). The names are
 * Emscripten's (`HEAPU8`, `_malloc`, `_tn_*`), so they are declared as record keys.
 */
type AbiCall =
  | "_malloc"
  | "_free"
  | "_tn_engine_version"
  | "_tn_context_create"
  | "_tn_type_id"
  | "_tn_object_release"
  | "_tn_object_engine_references"
  | "_tn_construct"
  | "_tn_invoke"
  | "_tn_get"
  | "_tn_set"
  | "_tn_set_callback"
  | "_tn_diagnostic_release"
  | "_tn_anim_tick";
export type TnAbiModule = Record<AbiCall, (...args: number[]) => number> &
  Partial<
    Record<"_tnw_attribute_view" | "_tnw_attribute_view_release", (...args: number[]) => number>
  > &
  Record<"HEAPU8", Uint8Array> &
  Record<"HEAPF64", Float64Array> &
  Record<"UTF8ToString", (pointer: number, maxBytes?: number) => string> &
  Record<
    "addFunction",
    (fn: (...args: number[]) => number | undefined, signature: string) => number
  > & {
    stringToUTF8(text: string, pointer: number, maxBytes: number): void;
    lengthBytesUTF8(text: string): number;
  };

// wasm32 layouts of tn_abi.h, measured with offsetof under emcc: tn_handle_t 12 bytes; tn_value_t
// 56 bytes (kind 0, boolean 4, number 8, handle 16, text 32, count 40, numbers 48); tn_diagnostic_t
// 8 bytes (message 0, code 4); tn_version_info_t 32 bytes. A struct passed by value goes by pointer.
export const HANDLE = 12;
export const VALUE = 56;
export const KIND = {
  null: 0,
  number: 1,
  bool: 2,
  string: 3,
  handle: 4,
  numbers: 5,
  array: 6,
  record: 7,
  undefined: 8,
  bytes: 9,
} as const;

// wasm32 layout of tn_tsl_arg_t (tn_tsl.h): kind 0, lanes 4, node 8 (u64), number 16, text 24,
// numbers 32 (four f64); 64 bytes. A handle argument's 12 bytes start at lanes (4) and run through node.
const TSL_ARG = 64;
const TSL_KIND = {
  node: 0,
  number: 1,
  string: 2,
  named: 3,
  rgb: 4,
  vector: 5,
  other: 6,
  handle: 7,
} as const;
type TslCall =
  | "_tn_tsl_call"
  | "_tn_tsl_release"
  | "_tn_tsl_set"
  | "_tn_tsl_set_uniform"
  | "_tn_tsl_set_uniforms"
  | "_tn_tsl_reads"
  | "_tn_tsl_effect_parameter"
  | "_tnw_web_set_post"
  | "_tnw_web_compute"
  | "_tnw_web_compute_flush"
  | "_tnw_web_read_storage"
  | "_tnw_web_read_storage_size"
  | "_tnw_web_read_storage_take"
  | "_tnw_web_delete_storage"
  | "_tnw_web_poll"
  | "_tnw_web_error";

export interface IAbiHelpers {
  scoped<T>(work: () => T): T;
  alloc(size: number): number;
  string(text: string): { pointer: number; bytes: number };
  diagnostic(): number;
  check(status: number, diag: number, what: string): void;
  handleOf(ref: IEngineRef): number;
  writeHandle(pointer: number, ref: IEngineRef): void;
  view(): DataView;
}

/** `tnw_web_load_gltf`'s handles: the default scene, the clips, then every scene in file order. */
function splitModel(refs: IEngineRef[], scenes: number) {
  const clipsEnd = refs.length - scenes;
  return {
    scene: refs[0] as IEngineRef,
    animations: refs.slice(1, clipsEnd),
    scenes: refs.slice(clipsEnd),
  };
}

/** The engine glTF loader over the product web host's `tnw_web_load_gltf`, when the module has it. */
export function gltfOf(
  abi: TnAbiModule,
  context: number,
  h: Pick<IAbiHelpers, "scoped" | "alloc"> & { keyOf(pointer: number): IEngineRef },
): Pick<IBrowserRuntime, "loadGltf" | "loadGltfAsync"> {
  // quality-allow: the Emscripten module is read through the exports this call site names, not its full surface.
  const host = abi as unknown as Partial<
    Record<
      | "_tnw_web_load_gltf"
      | "_tnw_web_load_gltf_begin"
      | "_tnw_web_load_gltf_done"
      | "_tnw_web_load_gltf_finish"
      | "_tnw_web_load_error"
      | "_tnw_web_gltf_file"
      | "_tnw_web_gltf_files_clear",
      (...args: number[]) => number
    >
  >;
  const {
    _tnw_web_load_gltf: load,
    _tnw_web_load_gltf_begin: begin,
    _tnw_web_load_gltf_done: done,
    _tnw_web_load_gltf_finish: finish,
    _tnw_web_load_error: error,
    _tnw_web_gltf_file: file,
    _tnw_web_gltf_files_clear: clearFiles,
  } = host;
  if (load === undefined || error === undefined) return {};
  /** Files the model names by relative uri (shared images), kept for the engine loader's next load. */
  const stageFiles = (files: ReadonlyMap<string, Uint8Array> | undefined): void => {
    if (files === undefined || files.size === 0) return;
    if (file === undefined || clearFiles === undefined)
      throw new Error(
        "TN_WASM_GLTF_FILES_UNAVAILABLE: this web engine cannot read a model's image files",
      );
    for (const [uri, content] of files) {
      // tnw_web_gltf_file keeps its own copy, so this scratch is dead once it returns. One scope
      // per file frees it at once: the peak is one file, not the sum of all of them.
      h.scoped(() => {
        const name = h.alloc(abi.lengthBytesUTF8(uri) + 1);
        abi.stringToUTF8(uri, name, abi.lengthBytesUTF8(uri) + 1);
        const copy = h.alloc(Math.max(1, content.byteLength));
        abi.HEAPU8.set(content, copy);
        file(name, copy, content.byteLength);
      });
    }
  };
  /**
   * The handles `share(out, capacity, count, scenes)` writes, retried once at the exact size for a
   * model with many clips.
   */
  const handles = (
    share: (out: number, capacity: number, count: number, scenes: number) => number,
  ) =>
    h.scoped(() => {
      const count = h.alloc(4);
      const sceneCount = h.alloc(4);
      for (let capacity = 64; ; ) {
        const out = h.alloc(HANDLE * capacity);
        const status = share(out, capacity, count, sceneCount);
        const needed = new DataView(abi.HEAPU8.buffer).getUint32(count, true);
        if (status === 0)
          return splitModel(
            Array.from({ length: needed }, (_, i) => h.keyOf(out + i * HANDLE)),
            new DataView(abi.HEAPU8.buffer).getUint32(sceneCount, true),
          );
        const reason = abi.UTF8ToString(error());
        if (reason !== "TN_WASM_GLTF_CAPACITY" || needed <= capacity) throw new Error(reason);
        capacity = needed;
      }
    });
  const loadGltf: NonNullable<IBrowserRuntime["loadGltf"]> = (bytes, files) =>
    h.scoped(() => {
      try {
        stageFiles(files);
        const data = h.alloc(Math.max(1, bytes.byteLength));
        abi.HEAPU8.set(bytes, data);
        return handles((out, capacity, count, scenes) =>
          load(context, data, bytes.byteLength, out, capacity, count, scenes),
        );
      } finally {
        clearFiles?.();
      }
    });
  if (begin === undefined || done === undefined || finish === undefined) return { loadGltf };
  return {
    loadGltf,
    // PRD-860: the engine parses on its loader thread, so a model that arrives during play costs the
    // main thread a poll and the hand-over, not the 100-500 ms parse Midway's late fleet froze on.
    loadGltfAsync: async (bytes, files) => {
      const ticket = h.scoped(() => {
        try {
          stageFiles(files);
          const data = h.alloc(Math.max(1, bytes.byteLength));
          abi.HEAPU8.set(bytes, data);
          // begin copies the bytes and takes the staged files with it.
          return begin(data, bytes.byteLength);
        } finally {
          clearFiles?.();
        }
      });
      if (ticket === 0) throw new Error("TN_WASM_GLTF: the engine refused the load");
      while (done(ticket) === 0) await new Promise((resolve) => setTimeout(resolve, GLTF_POLL_MS));
      return handles((out, capacity, count, scenes) =>
        finish(context, ticket, out, capacity, count, scenes),
      );
    },
  };
}

/** How often a pending engine glTF load is polled: a 4 ms timer costs nothing beside a 100 ms parse. */
const GLTF_POLL_MS = 4;

/** TSL by name over `tn_tsl_call`, when the module exports it (the product web host does). */
export function tslOf(
  abi: TnAbiModule,
  context: number,
  h: IAbiHelpers,
): { tsl: ITslRuntime } | undefined {
  // Node ids are u64 in the C ABI; Emscripten passes a 64-bit parameter as a BigInt.
  // quality-allow: the Emscripten module is read through the TSL call exports this call site names, not its full surface.
  const calls = abi as unknown as Partial<
    Record<TslCall, (...args: (number | bigint)[]) => number>
  >;
  const {
    _tn_tsl_call: call,
    _tn_tsl_release: release,
    _tn_tsl_set: set,
    _tn_tsl_set_uniform: setUniform,
    _tn_tsl_set_uniforms: setUniforms,
    _tn_tsl_reads: reads,
    _tn_tsl_effect_parameter: effectParameter,
    _tnw_web_set_post: setPost,
    _tnw_web_compute: computeNode,
    _tnw_web_compute_flush: computeFlush,
    _tnw_web_read_storage: readStorage,
    _tnw_web_read_storage_size: readStorageSize,
    _tnw_web_read_storage_take: readStorageTake,
    _tnw_web_delete_storage: deleteStorage,
    _tnw_web_poll: poll,
    _tnw_web_error: webError,
  } = calls;
  if (
    call === undefined ||
    release === undefined ||
    set === undefined ||
    setUniform === undefined ||
    effectParameter === undefined
  )
    return undefined;
  // PRD-878: the hooked uniform ids `reads` checks, kept in engine memory: the facade only appends to its list, so a
  // query writes just the ids added since the last one.
  let candidateAt = 0;
  let candidateRoom = 0;
  let candidatesWritten = 0;
  // Writes tn_tsl_arg_t values; text is allocated first, since an allocation can grow the memory.
  const writeArgs = (args: readonly TslArgValue[]): number => {
    const pointer = h.alloc(Math.max(TSL_ARG, args.length * TSL_ARG));
    args.forEach((arg, i) => {
      const at = pointer + i * TSL_ARG;
      const text = arg.kind === "string" || arg.kind === "named" ? h.string(arg.text).pointer : 0;
      const v = h.view();
      v.setUint32(at, TSL_KIND[arg.kind], true);
      if (arg.kind === "node") v.setBigUint64(at + 8, BigInt(arg.node), true);
      else if (arg.kind === "number") v.setFloat64(at + 16, arg.number, true);
      else if (arg.kind === "rgb" || arg.kind === "vector") {
        v.setUint32(at + 4, arg.numbers.length, true);
        arg.numbers.forEach((c, j) => v.setFloat64(at + 32 + j * 8, c, true));
      } else if (arg.kind === "handle") h.writeHandle(at + 4, arg.ref);
      else v.setUint32(at + 24, text, true);
    });
    return pointer;
  };
  const nodeOf = (node: number | null): number => {
    if (node === null) return 0;
    const pointer = h.alloc(8);
    h.view().setBigUint64(pointer, BigInt(node), true);
    return pointer;
  };
  return {
    tsl: {
      call: (name, receiver, args) =>
        h.scoped(() => {
          const pointer = writeArgs(args);
          const self = nodeOf(receiver);
          const out = h.alloc(8);
          const diag = h.diagnostic();
          h.check(
            call(context, h.string(name).pointer, self, pointer, args.length, out, diag),
            diag,
            `TSL ${name}`,
          );
          return Number(h.view().getBigUint64(out, true));
        }),
      release: (node) =>
        h.scoped(() => {
          const diag = h.diagnostic();
          release(context, BigInt(node), diag);
          abi._tn_diagnostic_release(diag);
        }),
      set: (material, path, node) =>
        h.scoped(() => {
          const diag = h.diagnostic();
          h.check(
            set(context, h.handleOf(material), h.string(path).pointer, BigInt(node), diag),
            diag,
            `set ${path}`,
          );
        }),
      effectParameter: (node, name, value) =>
        h.scoped(() => {
          const self = nodeOf(node);
          const input = value === undefined ? 0 : h.alloc(8);
          if (value !== undefined) h.view().setFloat64(input, value, true);
          const out = h.alloc(8);
          const diag = h.diagnostic();
          h.check(
            effectParameter(context, self, h.string(name).pointer, input, out, diag),
            diag,
            `effect ${name}`,
          );
          return h.view().getFloat64(out, true);
        }),
      // three's RenderPipeline on the product web host: the graph between scene and output.
      setPost: (node) =>
        h.scoped(() => {
          if (setPost === undefined) throw new Error("TN_WASM_POST: this module has no web host");
          if (setPost(context, nodeOf(node), 0) !== 0) throw new Error("TN_WASM_POST: refused");
        }),
      setToneMapping: (node) =>
        h.scoped(() => {
          if (setPost === undefined)
            throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: no web output binding");
          if (setPost(context, nodeOf(node), 1) !== 0)
            throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_INVALID: refused output node");
        }),
      // PRD-620: renderer.compute and storage reads over the product web host.
      compute: (node) =>
        h.scoped(() => {
          if (computeNode === undefined || webError === undefined)
            throw new Error("TN_WASM_COMPUTE: this module has no web host");
          if (computeNode(context, nodeOf(node)) !== 0)
            throw new Error(abi.UTF8ToString(webError()));
        }),
      readStorage: async (attribute) => {
        if (
          readStorage === undefined ||
          readStorageSize === undefined ||
          readStorageTake === undefined ||
          computeFlush === undefined ||
          poll === undefined ||
          webError === undefined
        )
          throw new Error("TN_WASM_COMPUTE: this module has no web host");
        const id = h.scoped(() => {
          const pointer = h.alloc(HANDLE);
          h.writeHandle(pointer, attribute);
          return readStorage(pointer);
        });
        if (id === 0) throw new Error(abi.UTF8ToString(webError()));
        computeFlush();
        for (;;) {
          poll();
          const size = readStorageSize(id);
          if (size > 0 || readStorageTake(id, 0, 0) < 0) {
            const out = abi._malloc(size) >>> 0;
            try {
              if (readStorageTake(id, out, size) === 1)
                return abi.HEAPU8.slice(out, out + size).buffer;
            } finally {
              abi._free(out);
            }
            throw new Error("TN_NATIVE_READ_STORAGE: the read failed");
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      deleteStorage: (attribute) =>
        h.scoped(() => {
          if (deleteStorage === undefined || webError === undefined)
            throw new Error("TN_WASM_COMPUTE: this module has no web host");
          const pointer = h.alloc(HANDLE);
          h.writeHandle(pointer, attribute);
          if (deleteStorage(pointer) !== 0) throw new Error(abi.UTF8ToString(webError()));
        }),
      setUniform: (node, lanes) =>
        h.scoped(() => {
          const pointer = h.alloc(8);
          const values = h.alloc(Math.max(8, lanes.length * 8));
          const v = h.view();
          v.setBigUint64(pointer, BigInt(node), true);
          lanes.forEach((lane, i) => v.setFloat64(values + i * 8, lane, true));
          const diag = h.diagnostic();
          h.check(setUniform(context, pointer, values, lanes.length, diag), diag, "uniform.value");
        }),
      ...(reads === undefined
        ? {}
        : {
            reads: (
              root: IEngineRef | undefined,
              kernels: readonly number[],
              candidates: readonly number[],
            ): number[] => {
              if (candidates.length > candidateRoom) {
                if (candidateAt !== 0) abi._free(candidateAt);
                candidateRoom = Math.max(16, candidates.length * 2);
                // The ids, then room for as many u32 answers.
                candidateAt = abi._malloc(candidateRoom * 12) >>> 0;
                candidatesWritten = 0;
              }
              const ids = h.view();
              for (; candidatesWritten < candidates.length; candidatesWritten += 1)
                ids.setBigUint64(
                  candidateAt + candidatesWritten * 8,
                  BigInt(candidates[candidatesWritten] as number),
                  true,
                );
              return h.scoped(() => {
                const rootAt = root === undefined ? 0 : h.alloc(HANDLE);
                if (root !== undefined) h.writeHandle(rootAt, root);
                const kernelAt = h.alloc(Math.max(8, kernels.length * 8));
                const countAt = h.alloc(4);
                const v = h.view();
                kernels.forEach((kernel, i) =>
                  v.setBigUint64(kernelAt + i * 8, BigInt(kernel), true),
                );
                const out = candidateAt + candidateRoom * 8;
                const diag = h.diagnostic();
                h.check(
                  reads(
                    context,
                    rootAt,
                    kernelAt,
                    kernels.length,
                    candidateAt,
                    candidates.length,
                    out,
                    countAt,
                    diag,
                  ),
                  diag,
                  "uniform reads",
                );
                const after = h.view();
                const picked: number[] = [];
                for (let i = 0, count = after.getUint32(countAt, true); i < count; i += 1)
                  picked.push(after.getUint32(out + i * 4, true));
                return picked;
              });
            },
          }),
      // PRD-828: a sync's changed uniforms as one `tn_tsl_set_uniforms` span; absent on an older module.
      ...(setUniforms === undefined
        ? {}
        : {
            setUniforms: (
              nodes: readonly number[],
              counts: readonly number[],
              lanes: readonly number[],
            ) =>
              h.scoped(() => {
                const ids = h.alloc(Math.max(8, nodes.length * 8));
                const widths = h.alloc(Math.max(4, counts.length * 4));
                const values = h.alloc(Math.max(8, lanes.length * 8));
                const v = h.view();
                nodes.forEach((node, i) => v.setBigUint64(ids + i * 8, BigInt(node), true));
                counts.forEach((count, i) => v.setUint32(widths + i * 4, count, true));
                lanes.forEach((lane, i) => v.setFloat64(values + i * 8, lane, true));
                const diag = h.diagnostic();
                h.check(
                  setUniforms(context, ids, widths, values, nodes.length, diag),
                  diag,
                  "uniform.value",
                );
              }),
          }),
    },
  };
}
