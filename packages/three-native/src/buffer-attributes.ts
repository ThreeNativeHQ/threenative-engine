// three's typed BufferAttribute subclasses, ported from three r187 src/core/BufferAttribute.js (MIT).
// Each one only converts its array: the engine BufferAttribute keeps a Uint8Array, Uint16Array or
// Uint32Array in its own storage type. Int16BufferAttribute stays unbound: the engine stores an
// Int16Array as float32, so a normalized Int16 attribute would read wrong on the GPU.

type Attribute = new (array: ArrayLike<number>, itemSize: number, normalized?: boolean) => object;

/** `Uint16BufferAttribute` is `defineTypedBufferAttribute(BufferAttribute, Uint16Array)`. */
export function defineTypedBufferAttribute(
  base: Attribute,
  storage: new (array: ArrayLike<number>) => ArrayLike<number>,
) {
  return class extends base {
    constructor(array: ArrayLike<number>, itemSize: number, normalized = false) {
      // three's default, explicit: the engine constructor refuses an undefined `normalized`.
      super(new storage(array), itemSize, normalized);
    }
  };
}
