export interface IGPUResources {
  readonly buffers: number;
  readonly bufferBytes: number;
  readonly textures: number;
  readonly bufferIds: readonly number[];
  readonly textureIds: readonly number[];
  readonly createdBuffers: number;
  readonly destroyedBuffers: number;
  readonly createdTextures: number;
  readonly destroyedTextures: number;
}
interface ILiveResource {
  readonly id: number;
  readonly bytes: number;
  readonly kind: "buffer" | "texture";
  readonly restore: () => void;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;
function replaceMethod(target: object, name: string, wrap: (method: Method) => Method) {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new Error(`missing ${name}`);
  const own = Object.getOwnPropertyDescriptor(target, name);
  const wrapper = wrap(method as Method);
  Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapper });
  return () => {
    if (Reflect.get(target, name) !== wrapper) throw new Error(`changed ${name} owner`);
    if (own) Object.defineProperty(target, name, own);
    else Reflect.deleteProperty(target, name);
  };
}

/** Scope: allocations on this game's device after installation; pre-existing resources are shared. */
export function observeGPUResources(device: unknown) {
  if (typeof device !== "object" || device === null)
    throw new Error("TN_ANIMAL_GPU_CENSUS_UNAVAILABLE: missing device");
  const live = new Map<object, ILiveResource>();
  const seen = new WeakSet<object>();
  const restores: (() => void)[] = [];
  let next = 1;
  let closed = false;
  let failure: unknown;
  let createdBuffers = 0;
  let destroyedBuffers = 0;
  let createdTextures = 0;
  let destroyedTextures = 0;
  try {
    for (const [methodName, kind] of [
      ["createBuffer", "buffer"],
      ["createTexture", "texture"],
    ] as const) {
      restores.push(
        replaceMethod(
          device,
          methodName,
          (method) =>
            function (this: unknown, ...args: unknown[]) {
              const resource: unknown = Reflect.apply(method, this, args);
              try {
                if (typeof resource !== "object" || resource === null || seen.has(resource))
                  throw new Error("allocation returned no distinct handle");
                const descriptor = args[0];
                const bytes =
                  kind === "buffer" && typeof descriptor === "object" && descriptor !== null
                    ? (Reflect.get(descriptor, "size") as unknown)
                    : 0;
                if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
                  throw new Error("missing buffer byte length");
                const restore = replaceMethod(
                  resource,
                  "destroy",
                  (destroy) =>
                    function (this: unknown, ...destroyArgs: unknown[]) {
                      const result: unknown = Reflect.apply(destroy, this, destroyArgs);
                      if (this !== resource) return result;
                      if (live.delete(resource)) {
                        if (kind === "buffer") destroyedBuffers++;
                        else destroyedTextures++;
                        restore();
                      }
                      return result;
                    },
                );
                seen.add(resource);
                live.set(resource, { id: next++, bytes, kind, restore });
                if (kind === "buffer") createdBuffers++;
                else createdTextures++;
                return resource;
              } catch (error) {
                failure = error;
                throw new Error(`TN_ANIMAL_GPU_CENSUS_UNAVAILABLE: ${String(error)}`);
              }
            },
        ),
      );
    }
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw new Error(`TN_ANIMAL_GPU_CENSUS_UNAVAILABLE: ${String(error)}`);
  }
  return {
    snapshot(): IGPUResources {
      if (closed) throw new Error("TN_ANIMAL_GPU_CENSUS_CLOSED");
      if (failure) throw new Error(`TN_ANIMAL_GPU_CENSUS_UNAVAILABLE: ${String(failure)}`);
      const buffers = [...live.values()].filter((resource) => resource.kind === "buffer");
      const textures = [...live.values()].filter((resource) => resource.kind === "texture");
      return Object.freeze({
        buffers: buffers.length,
        bufferBytes: buffers.reduce((total, resource) => total + resource.bytes, 0),
        textures: textures.length,
        bufferIds: Object.freeze(buffers.map((resource) => resource.id)),
        textureIds: Object.freeze(textures.map((resource) => resource.id)),
        createdBuffers,
        destroyedBuffers,
        createdTextures,
        destroyedTextures,
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      // Observation ends; it never destroys someone else's resource to manufacture reclamation.
      const errors: unknown[] = [];
      for (const restore of [...live.values()]
        .map((resource) => resource.restore)
        .concat(restores)
        .reverse()) {
        try {
          restore();
        } catch (error) {
          errors.push(error);
        }
      }
      live.clear();
      if (errors.length) throw new AggregateError(errors, "TN_ANIMAL_GPU_CENSUS_RESTORE");
    },
  };
}
