/**
 * A stand-in `AudioContext` for a game running in a dedicated worker, where no Web Audio API
 * exists (PRD-752). Every node is a handle; each call and property write crosses a `MessagePort`
 * and runs on the page's real graph, so three's audio classes and `AudioBus` work unchanged.
 */

interface IRemoteAudioInit {
  readonly sampleRate: number;
  readonly currentTime: number;
}

interface IGetOp {
  readonly op: "get";
  readonly id: number;
  readonly key: string;
  readonly out: number;
}

interface ICallOp {
  readonly op: "call";
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly out: number;
}

interface ISetOp {
  readonly op: "set";
  readonly id: number;
  readonly key: string;
  readonly value: unknown;
}

interface IDecodeOp {
  readonly op: "decode";
  readonly req: number;
  readonly out: number;
  readonly bytes: ArrayBuffer;
}

interface IFireOp {
  readonly op: "fire";
  readonly fn: number;
}

type PageOp = IGetOp | ICallOp | ISetOp | IDecodeOp;

interface IDecodedReply {
  readonly op: "decoded";
  readonly req: number;
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
}

interface IDecodeFailedReply {
  readonly op: "decodeFailed";
  readonly req: number;
  readonly message: string;
}

interface IDecodeSlot {
  readonly out: number;
  readonly resolve: (buffer: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onSuccess: ((buffer: unknown) => void) | undefined;
  readonly onError: ((error: Error) => void) | undefined;
}

/**
 * Keys whose page value is a node or an `AudioParam`. Reading one yields a child handle instead of
 * a call, because `gain.gain` and `source.buffer` are objects to drive, not functions to run.
 */
const OBJECT_KEYS: ReadonlySet<string> = new Set([
  "destination",
  "listener",
  "gain",
  "playbackRate",
  "detune",
  "positionX",
  "positionY",
  "positionZ",
  "orientationX",
  "orientationY",
  "orientationZ",
  "forwardX",
  "forwardY",
  "forwardZ",
  "upX",
  "upY",
  "upZ",
  "threshold",
  "knee",
  "ratio",
  "attack",
  "release",
  "frequency",
  "Q",
]);

/** Worker side: a page-side `AudioContext`, with every node replaced by a proxy handle. */
export function createRemoteAudioContext(port: MessagePort, init: IRemoteAudioInit): AudioContext {
  const createdAt = performance.now();
  const functions = new Map<number, (...args: unknown[]) => unknown>();
  const handleIds = new WeakMap<object, number>();
  const slots = new Map<number, IDecodeSlot>();
  let nextId = 1;
  let nextFnId = 1;
  let running = false;

  // One message per task: AudioListener alone moves nine AudioParams a frame.
  let queue: PageOp[] = [];
  let transfers: Transferable[] = [];
  const flush = (): void => {
    port.postMessage({ op: "batch", ops: queue }, transfers);
    queue = [];
    transfers = [];
  };
  const post = (message: PageOp, transfer?: Transferable[]): void => {
    if (queue.length === 0) queueMicrotask(flush);
    queue.push(message);
    if (transfer !== undefined) transfers.push(...transfer);
  };

  function encode(value: unknown): unknown {
    if (typeof value === "function") {
      const fnId = nextFnId++;
      functions.set(fnId, value as (...args: unknown[]) => unknown);
      return { $fn: fnId };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === "object") {
      const id = handleIds.get(value);
      if (id !== undefined) return { $h: id };
    }
    return value;
  }

  function readKey(id: number, cache: Map<string, unknown>, key: string): unknown {
    const override = id === 0 ? contextValue(key) : undefined;
    if (override !== undefined) return override.value;
    if (cache.has(key)) return cache.get(key);
    if (OBJECT_KEYS.has(key)) {
      const out = nextId++;
      const child = makeHandle(out);
      cache.set(key, child);
      post({ key, op: "get", id, out });
      return child;
    }
    // ponytail: a property the worker never wrote reads as a function, not the page's value.
    return (...args: unknown[]) => {
      const out = nextId++;
      post({ args: args.map(encode), method: key, op: "call", id, out });
      return makeHandle(out);
    };
  }

  function makeHandle(id: number, seed?: Record<string, unknown>): Record<string, unknown> {
    const cache = new Map<string, unknown>(Object.entries(seed ?? {}));
    const proxy = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (typeof key === "symbol" || key === "then") return undefined;
        return readKey(id, cache, key);
      },
      has: (_target, key) => typeof key === "string" && cache.has(key),
      set: (_target, key, value) => {
        if (typeof key === "symbol") return true;
        cache.set(key, value);
        post({ key, op: "set", id, value: encode(value) });
        return true;
      },
    });
    handleIds.set(proxy, id);
    return proxy;
  }

  function control(method: string): Promise<void> {
    post({ args: [], method, op: "call", id: 0, out: nextId++ });
    return Promise.resolve();
  }

  function decodeAudioData(
    data: ArrayBuffer,
    onSuccess?: (buffer: unknown) => void,
    onError?: (error: Error) => void,
  ): Promise<unknown> {
    const req = nextId++;
    const out = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      slots.set(req, { onError, onSuccess, out, reject, resolve });
      const bytes = data.slice(0);
      post({ bytes, op: "decode", out, req }, [bytes]);
    });
  }

  function contextValue(key: string): { readonly value: unknown } | undefined {
    switch (key) {
      case "currentTime":
        return { value: init.currentTime + (performance.now() - createdAt) / 1000 };
      case "sampleRate":
        return { value: init.sampleRate };
      case "state":
        return { value: running ? "running" : "suspended" };
      case "resume":
        return {
          value: () => {
            running = true;
            return control("resume");
          },
        };
      case "suspend":
        return {
          value: () => {
            running = false;
            return control("suspend");
          },
        };
      case "close":
        return {
          value: () => {
            running = false;
            return control("close");
          },
        };
      case "decodeAudioData":
        return { value: decodeAudioData };
      default:
        return undefined;
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const reply = event.data as IDecodedReply | IDecodeFailedReply | IFireOp | undefined;
    if (reply?.op === "decoded") {
      const slot = slots.get(reply.req);
      if (slot === undefined) return;
      slots.delete(reply.req);
      const buffer = makeHandle(slot.out, {
        duration: reply.duration,
        length: reply.length,
        numberOfChannels: reply.numberOfChannels,
        sampleRate: reply.sampleRate,
      });
      slot.resolve(buffer);
      slot.onSuccess?.(buffer);
      return;
    }
    if (reply?.op === "decodeFailed") {
      const slot = slots.get(reply.req);
      if (slot === undefined) return;
      slots.delete(reply.req);
      const error = new Error(reply.message);
      slot.onError?.(error);
      slot.reject(error);
      return;
    }
    if (reply !== undefined && "fn" in reply) {
      const fired = reply as IFireOp;
      functions.get(fired.fn)?.();
    }
  };

  return makeHandle(0) as unknown as AudioContext;
}

/** Page side: runs the real graph for a worker's handles until the returned stop is called. */
export function serveRemoteAudio(port: MessagePort, context: BaseAudioContext): () => void {
  const objects = new Map<number, unknown>([[0, context]]);
  const warned = new Set<string>();
  let stopped = false;

  function decodeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeValue);
    if (value !== null && typeof value === "object") {
      const handle = (value as { $h?: number }).$h;
      if (typeof handle === "number") return objects.get(handle);
      const fn = (value as { $fn?: number }).$fn;
      if (typeof fn === "number") return () => port.postMessage({ fn, op: "fire" });
    }
    return value;
  }

  function warn(op: string | undefined, error: unknown): void {
    const name = op ?? "unknown";
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`serveRemoteAudio: "${name}" failed; later failures stay quiet.`, error);
  }

  async function serveDecode(op: IDecodeOp): Promise<void> {
    try {
      const buffer = await context.decodeAudioData(op.bytes);
      if (stopped) return;
      objects.set(op.out, buffer);
      port.postMessage({
        duration: buffer.duration,
        length: buffer.length,
        numberOfChannels: buffer.numberOfChannels,
        op: "decoded",
        req: op.req,
        sampleRate: buffer.sampleRate,
      });
    } catch (error) {
      if (stopped) return;
      port.postMessage({
        message: error instanceof Error ? error.message : String(error),
        op: "decodeFailed",
        req: op.req,
      });
    }
  }

  port.onmessage = (event: MessageEvent) => {
    if (stopped) return;
    for (const op of (event.data as { ops: PageOp[] }).ops) run(op);
  };

  function run(op: PageOp): void {
    try {
      switch (op?.op) {
        case "get": {
          const source = objects.get(op.id) as Record<string, unknown> | undefined;
          objects.set(op.out, source?.[op.key]);
          break;
        }
        case "call": {
          const target = objects.get(op.id) as Record<string, unknown>;
          const method = target[op.method] as (...args: unknown[]) => unknown;
          const result = method.apply(target, op.args.map(decodeValue));
          if (result !== null && typeof result === "object") objects.set(op.out, result);
          break;
        }
        case "set": {
          const target = objects.get(op.id) as Record<string, unknown>;
          target[op.key] = decodeValue(op.value);
          break;
        }
        case "decode": {
          void serveDecode(op);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      warn(op.op, error);
    }
  }

  return () => {
    stopped = true;
    port.onmessage = null;
    port.close();
  };
}
