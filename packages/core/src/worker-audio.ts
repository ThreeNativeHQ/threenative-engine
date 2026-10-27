/**
 * A stand-in `AudioContext` for a game running in a dedicated worker, where no Web Audio API
 * exists (PRD-752). Every node is a handle; each call and property write crosses a `MessagePort`
 * and runs on the page's real graph, so three's audio classes and `AudioBus` work unchanged.
 */

interface IRemoteAudioInit {
  readonly sampleRate: number;
  readonly currentTime: number;
}

interface IClockReply {
  readonly op: "clock";
  readonly currentTime: number;
  readonly state: AudioContextState;
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
  readonly once?: boolean;
}

interface IControlOp {
  readonly op: "control";
  readonly method: "resume" | "suspend" | "close";
  readonly req: number;
}
interface IControlReply {
  readonly op: "controlled";
  readonly req: number;
  readonly currentTime: number;
  readonly state: AudioContextState;
  readonly message?: string;
}

type PageOp = IGetOp | ICallOp | ISetOp | IDecodeOp | IControlOp;

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
const PARAM_DEFAULTS: Readonly<Record<string, number>> = {
  gain: 1,
  playbackRate: 1,
  detune: 0,
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  orientationX: 1,
  orientationY: 0,
  orientationZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
  upX: 0,
  upY: 1,
  upZ: 0,
  threshold: -24,
  knee: 30,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
  frequency: 350,
};
const OBJECT_KEYS: ReadonlySet<string> = new Set([
  "destination",
  "listener",
  "Q",
  ...Object.keys(PARAM_DEFAULTS),
]);

const PARAM_METHODS: ReadonlySet<string> = new Set([
  "setValueAtTime",
  "linearRampToValueAtTime",
  "exponentialRampToValueAtTime",
  "setTargetAtTime",
  "setValueCurveAtTime",
  "cancelScheduledValues",
  "cancelAndHoldAtTime",
]);

const METHODS: ReadonlySet<string> = new Set([
  ...PARAM_METHODS,
  "connect",
  "disconnect",
  "addEventListener",
  "removeEventListener",
  "start",
  "stop",
  "setPosition",
  "setOrientation",
  "setVelocity",
  "setPeriodicWave",
  "getChannelData",
  "copyFromChannel",
  "copyToChannel",
  "getFloatFrequencyData",
  "getByteFrequencyData",
  "getFloatTimeDomainData",
  "getByteTimeDomainData",
  "getFrequencyResponse",
  "createGain",
  "createBufferSource",
  "createPanner",
  "createStereoPanner",
  "createBiquadFilter",
  "createDynamicsCompressor",
  "createOscillator",
  "createConstantSource",
  "createAnalyser",
  "createBuffer",
  "createChannelMerger",
  "createChannelSplitter",
  "createConvolver",
  "createDelay",
  "createIIRFilter",
  "createMediaElementSource",
  "createMediaStreamSource",
  "createMediaStreamDestination",
  "createPeriodicWave",
  "createScriptProcessor",
  "createWaveShaper",
]);

interface IParamReply {
  readonly op: "param";
  readonly id: number;
  readonly values: Record<string, number>;
}
interface IReleasedReply {
  readonly op: "released";
  readonly id: number;
}

/** Worker side: a page-side `AudioContext`, with every node replaced by a proxy handle. */
export function createRemoteAudioContext(port: MessagePort, init: IRemoteAudioInit): AudioContext {
  let anchoredAt = performance.now();
  let currentTime = init.currentTime;
  let state: AudioContextState = "suspended";
  const functions = new Map<number, (...args: unknown[]) => unknown>();
  const handleIds = new WeakMap<object, number>();
  const slots = new Map<number, IDecodeSlot>();
  const controls = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const params = new Map<number, { cache: Map<string, unknown>; written: Set<string> }>();
  let nextId = 1;
  let nextFnId = 1;

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

  function readKey(
    id: number,
    cache: Map<string, unknown>,
    key: string,
    proxy: Record<string, unknown>,
  ): unknown {
    const override = id === 0 ? contextValue(key) : undefined;
    if (override !== undefined) return override.value;
    if (cache.has(key)) return cache.get(key);
    if (OBJECT_KEYS.has(key)) {
      const out = nextId++;
      const value = key === "Q" ? 1 : PARAM_DEFAULTS[key];
      // Standard defaults are available in this task; the page sends the actual param bounds.
      const child = makeHandle(
        out,
        value === undefined ? undefined : { value, defaultValue: value },
      );
      cache.set(key, child);
      post({ key, op: "get", id, out });
      return child;
    }
    if (!METHODS.has(key))
      throw new Error(`Remote AudioContext: unknown property "${key}" on handle ${id}`);
    return (...args: unknown[]) => {
      const fluent = PARAM_METHODS.has(key);
      if (fluent && !key.startsWith("cancel") && typeof args[0] === "number") {
        cache.set("value", args[0]);
        params.get(id)?.written.add("value");
      }
      const destination = key === "connect" ? args[0] : undefined;
      const existing =
        destination !== null && typeof destination === "object"
          ? handleIds.get(destination)
          : undefined;
      const out = fluent ? id : (existing ?? nextId++);
      post({ args: args.map(encode), method: key, op: "call", id, out });
      return fluent ? proxy : existing === undefined ? makeHandle(out) : destination;
    };
  }

  function makeHandle(id: number, seed?: Record<string, unknown>): Record<string, unknown> {
    const cache = new Map<string, unknown>(Object.entries(seed ?? {}));
    const written = new Set<string>();
    let endedFn: number | undefined;
    if (typeof seed?.value === "number") params.set(id, { cache, written });
    const proxy = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (typeof key === "symbol" || key === "then") return undefined;
        return readKey(id, cache, key, proxy);
      },
      has: (_target, key) => typeof key === "string" && cache.has(key),
      set: (_target, key, value) => {
        if (typeof key === "symbol") return true;
        if (key === "onended") {
          if (endedFn !== undefined) functions.delete(endedFn);
          endedFn = typeof value === "function" ? nextFnId : undefined;
        }
        cache.set(key, value);
        written.add(key);
        post({ key, op: "set", id, value: encode(value) });
        return true;
      },
    });
    handleIds.set(proxy, id);
    return proxy;
  }

  function control(method: IControlOp["method"]): Promise<void> {
    const req = nextId++;
    return new Promise<void>((resolve, reject) => {
      controls.set(req, { resolve, reject });
      post({ op: "control", method, req });
    });
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
        return {
          value: currentTime + (state === "running" ? (performance.now() - anchoredAt) / 1000 : 0),
        };
      case "sampleRate":
        return { value: init.sampleRate };
      case "state":
        return { value: state };
      case "resume":
      case "suspend":
      case "close":
        return { value: () => control(key) };
      case "decodeAudioData":
        return { value: decodeAudioData };
      default:
        return undefined;
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const reply = event.data as
      | IDecodedReply
      | IDecodeFailedReply
      | IFireOp
      | IClockReply
      | IParamReply
      | IReleasedReply
      | IControlReply
      | undefined;
    if (reply?.op === "param") {
      const param = params.get(reply.id);
      if (param)
        for (const [key, value] of Object.entries(reply.values)) {
          if (!param.written.has(key)) param.cache.set(key, value);
        }
      return;
    }
    if (reply?.op === "released") {
      params.delete(reply.id);
      return;
    }
    if (reply?.op === "clock" || reply?.op === "controlled") {
      currentTime = reply.currentTime;
      state = reply.state;
      anchoredAt = performance.now();
      if (reply.op === "controlled") {
        const pending = controls.get(reply.req);
        controls.delete(reply.req);
        if (reply.message === undefined) pending?.resolve();
        else pending?.reject(new Error(reply.message));
      }
      return;
    }
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
      const fn = functions.get(fired.fn);
      if (fired.once) functions.delete(fired.fn);
      fn?.();
    }
  };

  return makeHandle(0) as unknown as AudioContext;
}

/** Page side: runs the real graph for a worker's handles until the returned stop is called. */
export function serveRemoteAudio(port: MessagePort, context: BaseAudioContext): () => void {
  const objects = new Map<number, unknown>([[0, context]]);
  const warned = new Set<string>();
  const parents = new Map<number, number>();
  let stopped = false;
  const syncClock = (): void => {
    if (!stopped)
      port.postMessage({ op: "clock", currentTime: context.currentTime, state: context.state });
  };
  context.addEventListener("statechange", syncClock);
  syncClock();

  function decodeValue(value: unknown, once = false): unknown {
    if (Array.isArray(value)) return value.map((entry) => decodeValue(entry));
    if (value !== null && typeof value === "object") {
      const handle = (value as { $h?: number }).$h;
      if (typeof handle === "number") return objects.get(handle);
      const fn = (value as { $fn?: number }).$fn;
      if (typeof fn === "number") return () => port.postMessage({ fn, op: "fire", once });
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

  async function serveControl(op: IControlOp): Promise<void> {
    let message: string | undefined;
    try {
      await (context as AudioContext)[op.method]();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!stopped)
      port.postMessage({
        op: "controlled",
        req: op.req,
        currentTime: context.currentTime,
        state: context.state,
        ...(message === undefined ? {} : { message }),
      });
  }

  port.onmessage = (event: MessageEvent) => {
    if (stopped) return;
    for (const op of (event.data as { ops: PageOp[] }).ops) run(op);
    syncClock();
  };

  function release(id: number): void {
    objects.delete(id);
    port.postMessage({ op: "released", id });
    parents.delete(id);
    for (const [child, parent] of parents) if (parent === id) release(child);
  }

  function run(op: PageOp): void {
    try {
      switch (op?.op) {
        case "get": {
          const source = objects.get(op.id) as Record<string, unknown> | undefined;
          objects.set(op.out, source?.[op.key]);
          parents.set(op.out, op.id);
          const param = source?.[op.key] as Record<string, unknown> | undefined;
          if (typeof param?.value === "number") {
            const values = Object.fromEntries(
              ["value", "defaultValue", "minValue", "maxValue"].flatMap((key) =>
                typeof param[key] === "number" ? [[key, param[key]]] : [],
              ),
            );
            port.postMessage({ op: "param", id: op.out, values });
          }
          break;
        }
        case "call": {
          const target = objects.get(op.id) as Record<string, unknown>;
          const method = target[op.method] as (...args: unknown[]) => unknown;
          const result = method.apply(
            target,
            op.args.map((arg) => decodeValue(arg)),
          );
          if (result !== null && typeof result === "object") objects.set(op.out, result);
          if (
            ["createBufferSource", "createOscillator", "createConstantSource"].includes(op.method)
          ) {
            const source = result as AudioScheduledSourceNode;
            source.addEventListener(
              "ended",
              () => {
                // A one-shot cannot restart; disconnect its graph edge and release its params too.
                source.disconnect();
                release(op.out);
              },
              { once: true },
            );
          }
          break;
        }
        case "set": {
          const target = objects.get(op.id) as Record<string, unknown>;
          target[op.key] = decodeValue(op.value, op.key === "onended");
          break;
        }
        case "control": {
          void serveControl(op);
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
    context.removeEventListener("statechange", syncClock);
    objects.clear();
    parents.clear();
    port.onmessage = null;
    port.close();
  };
}
