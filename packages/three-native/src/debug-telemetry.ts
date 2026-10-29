import { PLAYTEST_OBSERVING_GLOBAL, callerOf } from "./bridge-meter.js";

/** Kept local to the bridge so three-native does not depend on core. */
export function debugRequested(): boolean {
  const host = globalThis as {
    process?: { env?: Record<string, unknown> };
    [name: string]: unknown;
  };
  return (
    host.process?.env?.TN_DEBUG === "1" ||
    /[?&]tnDebug=1(?:&|$)/u.test(globalThis.location?.search ?? "") ||
    host.__THREENATIVE_DEBUG__ === true
  );
}

type DebugSource = { area: string; caller: string; lever?: string; unit?: string };

/** Debug-only cumulative totals; the existing engine counter reader owns windows and reports. */
export class DebugTelemetry {
  readonly totals: Record<string, number> = {};
  #names = new Map<string, string>();
  #reads = new Map<string, Set<string>>();
  #readCount = 0;

  add(
    name: string,
    amount = 1,
    area = "bridge",
    caller = "browser-backend.ts",
    unit?: string,
  ): void {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error(`TN_DEBUG: invalid ${name} observation.`);
    this.totals[name] = (this.totals[name] ?? 0) + amount;
    const host = globalThis as { __tnDebugSources?: Record<string, DebugSource> };
    host.__tnDebugSources ??= {};
    host.__tnDebugSources[name] ??= {
      area,
      caller,
      ...(area === "bridge"
        ? {
            lever:
              "PERFORMANCE-LEARNINGS.md#2026-10-27--web-engine-bridge-keep-what-game-code-reads-again-three-native-back-end--keep",
          }
        : {}),
      ...(unit === undefined ? {} : { unit }),
    };
  }

  crossing(kind: string, self: { key: string; type: number }, name: string, type: string): void {
    if (((globalThis as Record<string, unknown>)[PLAYTEST_OBSERVING_GLOBAL] as number) > 0) return;
    this.add("bridgeCrossings");
    this.add(`bridge${kind[0]?.toUpperCase()}${kind.slice(1)}Crossings`);
    const label = `${kind} ${type}.${name}`;
    let counter = this.#names.get(label);
    if (counter === undefined && this.#names.size < 4096) {
      counter = `bridge:${label}`;
      this.#names.set(label, counter);
      this.add(counter, 0, "bridge", callerOf(captureStack()));
    }
    if (counter !== undefined) this.add(counter);
    else this.add("bridgeOtherNameCrossings");
    if (kind === "call" || kind === "attributeWrite") {
      this.#readCount -= this.#reads.get(self.key)?.size ?? 0;
      this.#reads.delete(self.key);
    } else if (kind === "set" && this.#reads.get(self.key)?.delete(name)) this.#readCount--;
    if (kind !== "get") return;
    const reads = this.#reads.get(self.key);
    if (reads?.has(name)) {
      this.add("bridgeRedundantReads");
      return;
    }
    // Bound retained identities during a pathological frame; crossing totals remain complete.
    if (this.#readCount >= 65536) return;
    if (reads === undefined) this.#reads.set(self.key, new Set([name]));
    else reads.add(name);
    this.#readCount++;
  }

  frame(): void {
    this.#reads.clear();
    this.#readCount = 0;
  }

  widen(value: { readonly byteLength: number; readonly length: number }, property: string): void {
    const encodedBytes = value.length * 8;
    this.add("bridgeTypedSourceBytes", value.byteLength);
    this.add("bridgeTypedEncodedBytes", encodedBytes);
    if (encodedBytes <= value.byteLength) return;
    this.add("bridgeWidenings");
    this.add("bridgeWidenedBytes", encodedBytes);
    const label = `widen ${property}`;
    if (!this.#names.has(label) && this.#names.size < 4096) {
      const counter = `bridge:${label}`;
      this.#names.set(label, counter);
      this.add(counter, 0, "bridge", callerOf(captureStack()), "encoded bytes");
    }
    const counter = this.#names.get(label);
    if (counter !== undefined) this.add(counter, encodedBytes);
  }
}

const meters = new WeakMap<object, DebugTelemetry>();
export function debugTelemetry(owner: object): DebugTelemetry | undefined {
  if (!debugRequested()) return undefined;
  let meter = meters.get(owner);
  if (meter === undefined) {
    meter = new DebugTelemetry();
    meters.set(owner, meter);
  }
  return meter;
}

function captureStack(): string | undefined {
  return new Error().stack;
}
