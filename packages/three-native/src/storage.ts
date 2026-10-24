/**
 * three's storage buffers over engine BufferAttributes, for both back ends (PRD-620): the
 * StorageBufferAttribute classes, `storage(attribute, type, count)`, `instancedArray` and
 * `attributeArray` over the engine's `storage` node, and `renderer.getArrayBufferAsync`'s result forms.
 * An attribute holds the buffer's initial contents; the engine owns the GPU copy a kernel writes.
 */
interface IStorageNode {
  [key: string]: unknown;
}
type TypedArrayClass = new (length: number) => ArrayBufferView & { length: number };
type StorageArray = ArrayBufferView & {
  length: number;
  subarray(a: number, b: number): StorageArray;
};

const lengths: Readonly<Record<string, number>> = {
  float: 1,
  int: 1,
  uint: 1,
  bool: 1,
  vec2: 2,
  ivec2: 2,
  uvec2: 2,
  vec3: 3,
  ivec3: 3,
  uvec3: 3,
  vec4: 4,
  ivec4: 4,
  uvec4: 4,
  mat3: 9,
  mat4: 16,
};

function lengthOf(type: unknown): number {
  const length = typeof type === "string" ? lengths[type] : undefined;
  if (length === undefined)
    throw new TypeError(
      `TN_TSL storage: the native engine holds ${Object.keys(lengths).join(", ")} elements, not ${String(type)}`,
    );
  return length;
}

function arrayClassOf(type: string): TypedArrayClass {
  if (type === "uint" || type.startsWith("uvec")) return Uint32Array;
  if (type === "int" || type.startsWith("ivec")) return Int32Array;
  return Float32Array;
}

/** WGSL lays a vec3 array out at 16 bytes an element, so three pads a packed itemSize 3 array to 4. */
function padded(array: StorageArray, itemSize: number): [StorageArray, number] {
  if (itemSize !== 3) return [array, itemSize];
  const count = array.length / 3;
  const out = new (array.constructor as new (length: number) => StorageArray)(count * 4);
  // quality-allow: the typed array's set() is called on a view the constructor cast cannot name.
  const target = out as unknown as { set(source: ArrayLike<number>, offset: number): void };
  for (let i = 0; i < count; i += 1) target.set(array.subarray(i * 3, i * 3 + 3) as never, i * 4);
  return [out, 4];
}

/**
 * three's ReadbackBuffer (renderers/common/ReadbackBuffer.js): the caller-owned target of
 * `renderer.getArrayBufferAsync(attribute, target)`, which assigns `target.buffer` the bytes.
 */
export class ReadbackBuffer {
  isReadbackBuffer = true;
  name = "";
  buffer: ArrayBuffer | null = null;
  readonly maxByteLength: number;
  #listeners = new Map<string, Set<(event: object) => void>>();
  constructor(maxByteLength: number) {
    this.maxByteLength = maxByteLength;
  }
  addEventListener(type: string, listener: (event: object) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: object) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: { type: string }): void {
    for (const listener of [...(this.#listeners.get(event.type) ?? [])])
      listener.call(this, { ...event, target: this });
  }
  release(): void {
    this.dispatchEvent({ type: "release" });
  }
  dispose(): void {
    this.dispatchEvent({ type: "dispose" });
  }
}

export function defineStorage(
  tsl: {
    storage(attribute: unknown, type: string, count: number): IStorageNode;
    readonly instanceIndex: unknown;
    readonly vertexIndex: unknown;
    varying(value: unknown): unknown;
  },
  BufferAttribute: new (
    array: ArrayBufferView,
    itemSize: number,
  ) => { count: number; itemSize: number; needsUpdate: boolean },
) {
  const make = (flag: string) => {
    const Attribute = class extends BufferAttribute {
      constructor(
        count: number | StorageArray,
        itemSize: number,
        typeClass: TypedArrayClass = Float32Array,
      ) {
        const array = ArrayBuffer.isView(count)
          ? (count as StorageArray)
          : (new typeClass(count * itemSize) as StorageArray);
        const [stored, stride] = padded(array, itemSize);
        super(stored, stride);
        // The contents reach the engine now (the Wasm facade holds a handed array until its next engine call),
        // so no later write-back lands over what a kernel has written.
        this.needsUpdate = true;
      }
    };
    Object.defineProperty(Attribute.prototype, flag, { value: true });
    return Attribute;
  };
  const StorageBufferAttribute = make("isStorageBufferAttribute");
  const StorageInstancedBufferAttribute = make("isStorageInstancedBufferAttribute");

  const storage = (
    value: {
      count: number;
      itemSize: number;
      isStorageInstancedBufferAttribute?: boolean;
      isInstancedBufferAttribute?: boolean;
    },
    type: unknown = null,
    count = 0,
  ) => {
    if (type !== null && typeof type !== "string")
      throw new TypeError(
        "TN_TSL storage: a struct element type is not supported on the native engine",
      );
    const elementType = type ?? ["float", "vec2", "vec3", "vec4"][value.itemSize - 1];
    if (elementType === undefined) throw new TypeError("TN_TSL storage: name the element type");
    const node = tsl.storage(value, elementType, count || value.count);
    Object.defineProperty(node, "value", { value, enumerable: true });
    Object.defineProperty(node, "isStorageBufferNode", { value: true });
    // A vertex attribute is interpolated to fragments; only instanced storage uses the instance index.
    Object.defineProperty(node, "toAttribute", {
      value: () =>
        tsl.varying(
          (node.element as (index: unknown) => unknown)(
            value.isStorageInstancedBufferAttribute || value.isInstancedBufferAttribute
              ? tsl.instanceIndex
              : tsl.vertexIndex,
          ),
        ),
    });
    return node;
  };
  const array =
    (Attribute: typeof StorageBufferAttribute) =>
    (count: number | StorageArray, type = "float") => {
      const itemSize = lengthOf(type);
      const attribute = new Attribute(count, itemSize, arrayClassOf(type));
      if (attribute.count === 0)
        throw new TypeError("TN_TSL instancedArray: storage count must be positive");
      return storage(attribute, type, attribute.count);
    };
  return {
    StorageBufferAttribute,
    StorageInstancedBufferAttribute,
    storage,
    attributeArray: array(StorageBufferAttribute),
    instancedArray: array(StorageInstancedBufferAttribute),
  };
}

interface IReadbackBuffer {
  isReadbackBuffer?: boolean;
  buffer: unknown;
}

/**
 * `renderer.getArrayBufferAsync(attribute, target, offset, count)`: the buffer's bytes as a new
 * ArrayBuffer, or written into a ReadbackBuffer (`target.buffer`) or an ArrayBuffer target.
 */
export async function readStorageBytes(
  read: (attribute: unknown) => Promise<ArrayBuffer>,
  attribute: unknown,
  target: ArrayBuffer | IReadbackBuffer | null = null,
  offset = 0,
  count = -1,
): Promise<ArrayBuffer | IReadbackBuffer> {
  if (offset % 4 !== 0 || (count > 0 && count % 4 !== 0))
    throw new Error(
      'THREE.Renderer: "getArrayBufferAsync()" offset and count must be a multiple of 4.',
    );
  const all = await read(attribute);
  const bytes = all.slice(offset, count === -1 ? all.byteLength : offset + count);
  if (target === null) return bytes;
  if ((target as IReadbackBuffer).isReadbackBuffer === true) {
    (target as IReadbackBuffer).buffer = bytes;
    return target;
  }
  new Uint8Array(target as ArrayBuffer).set(new Uint8Array(bytes));
  return target;
}

/** r185's StorageTextureNode: retain the resource and append a store only when asked. */
export function defineStorageTextures(tsl: {
  storageTexture(...args: unknown[]): object;
  textureStore(...args: unknown[]): object;
}) {
  const { storageTexture, textureStore } = tsl;
  const decorate = (node: object, value: unknown, uv?: unknown, stored?: unknown) =>
    Object.assign(node, {
      isStorageTextureNode: true,
      value,
      store: (coordinate: unknown, data: unknown) =>
        decorate(textureStore(node, coordinate, data), value, coordinate, data),
      toStack() {
        textureStore(node, uv, stored);
        return node;
      },
    });
  return {
    storageTexture: (value: unknown, uv?: unknown, stored?: unknown) =>
      decorate(
        storageTexture(value, ...[uv, stored].filter((arg) => arg !== undefined)),
        value,
        uv,
        stored,
      ),
    textureStore: (value: unknown, uv: unknown, stored: unknown) =>
      decorate(
        textureStore(value, uv, stored),
        (value as { isStorageTextureNode?: boolean; value?: unknown })?.isStorageTextureNode
          ? (value as { value: unknown }).value
          : value,
        uv,
        stored,
      ),
  };
}
