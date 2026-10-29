import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The serialisation half of the capture environment bake-in (abstraction report §2.10).
 *
 * Concurrent pixel-producing runs contend for the same GPU and compositor, so they must be
 * serialised — but a solo run must not pay for a queue it never joins, and an agent that
 * cannot see lock state cannot tell "my test failed" from "someone else's test is running".
 * The policy is therefore decided from detected concurrency plus the explicit
 * `CAPTURE_LOCK=1` opt-in:
 *
 * - solo, unforced: no lock at all; state printed either way;
 * - concurrency detected or forced: the run queues on the capture lock with a long default
 *   timeout when contended (120 s) and a low one when forced solo (10 s), both overridable
 *   via `CAPTURE_LOCK_TIMEOUT_MS`;
 * - a timeout exits 75 printing `LOCK TIMEOUT … NOT a test failure` with the holder and the
 *   queue depth — the worst false-FAIL this harness can manufacture must stay named as such.
 *
 * The lock itself is an atomic directory create holding a `holder.json` record, not a POSIX
 * flock: Node exposes no flock binding and this package takes no native dependencies. The
 * semantics are the ones that matter here — mutual exclusion, liveness-checked holders (a
 * dead holder's lock is stolen), bounded waiting, and observable queue depth.
 */

export const CAPTURE_LOCK_TIMEOUT_MS_CONTESTED = 120_000;
export const CAPTURE_LOCK_TIMEOUT_MS_SOLO_FORCED = 10_000;

export interface ILockPolicyNone {
  mode: "none";
}

export interface ILockPolicyFlock {
  mode: "flock";
  timeoutMs: number;
  trigger: "CAPTURE_LOCK" | "concurrency";
}

export type ILockPolicy = ILockPolicyNone | ILockPolicyFlock;

export interface ILockDecisionInput {
  /** Raw `CAPTURE_LOCK` value; only "1" and "true" force locking. */
  captureLock?: string;
  /** Raw `CAPTURE_LOCK_TIMEOUT_MS` value; malformed values throw rather than being ignored. */
  lockTimeoutMs?: string;
  othersAlive: number;
}

export function decideLockPolicy(input: ILockDecisionInput): ILockPolicy {
  const forced = input.captureLock === "1" || input.captureLock === "true";
  const contended = input.othersAlive > 0;
  if (!forced && !contended) return { mode: "none" };
  return {
    mode: "flock",
    timeoutMs: readLockTimeout(input.lockTimeoutMs, contended),
    trigger: contended ? "concurrency" : "CAPTURE_LOCK",
  };
}

function readLockTimeout(raw: string | undefined, contended: boolean): number {
  if (raw === undefined) return contended ? CAPTURE_LOCK_TIMEOUT_MS_CONTESTED : CAPTURE_LOCK_TIMEOUT_MS_SOLO_FORCED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`CAPTURE_LOCK_TIMEOUT_MS must be a positive integer, received '${raw}'.`);
  }
  return parsed;
}

export function defaultCaptureLockRoot(): string {
  return join(tmpdir(), "threenative-playtest-capture");
}

const LOCK_DIR_NAME = "lock";
const QUEUE_DIR_NAME = "queue";
const HOLDER_FILE = "holder.json";

interface ILockHolderRecord {
  command?: string;
  pid: number;
  startedAt: string;
}

export interface IDetectConcurrencyOptions {
  isProcessAlive: (pid: number) => boolean;
  lockRoot: string;
}

/**
 * How many other runners currently hold or wait on the capture lock. A missing or stale
 * (dead-holder) lock reads as zero; a malformed holder record throws, because guessing solo
 * here is how two runs end up fighting over one GPU.
 */
export function detectCaptureConcurrency(options: IDetectConcurrencyOptions): number {
  const holder = readHolder(lockDirOf(options.lockRoot));
  if (holder === undefined) return 0;
  return options.isProcessAlive(holder.pid) ? 1 : 0;
}

function lockDirOf(lockRoot: string): string {
  return join(lockRoot, LOCK_DIR_NAME);
}

function queueDirOf(lockRoot: string): string {
  return join(lockRoot, QUEUE_DIR_NAME);
}

/** `undefined` means no live-looking holder file; a malformed one throws (fail closed). */
function readHolder(lockDirectory: string): ILockHolderRecord | undefined {
  const path = join(lockDirectory, HOLDER_FILE);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    // Sync is fine here: a few bytes under our own tmpdir, read on the acquire path only.
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ILockHolderRecord>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) throw new Error("bad pid");
    return { ...(parsed.command === undefined ? {} : { command: parsed.command }), pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    throw new Error(`Malformed capture lock holder record at ${path}; remove the stale '${lockDirectory}' directory if no playtest is running.`);
  }
}

export class CaptureLockTimeoutError extends Error {
  constructor(
    readonly holderSummary: string,
    readonly queueDepth: number,
    readonly waitedMs: number,
  ) {
    super(
      `LOCK TIMEOUT after ${waitedMs}ms waiting for another playtest's capture lock `
        + `— holder ${holderSummary}, queue depth ${queueDepth}.`,
    );
    this.name = "CaptureLockTimeoutError";
  }
}

export function formatLockTimeoutLine(error: CaptureLockTimeoutError): string {
  return `${error.message} NOT a test failure: rerun the same command once the other capture run finishes.`;
}

export interface ILockStateEvent {
  holderSummary?: string;
  mode: "held" | "waiting";
  queueDepth: number;
}

export interface IAcquireCaptureLockOptions {
  /** Recorded in the holder file so timeouts can name who holds the lock. */
  command?: string;
  isProcessAlive?: (pid: number) => boolean;
  lockRoot?: string;
  now?: () => number;
  onState?: (state: ILockStateEvent) => void;
  /** Injectable for tests; defaults to this process. */
  pid?: number;
  pollIntervalMs?: number;
  timeoutMs: number;
}

export interface ICaptureLease {
  release: () => Promise<void>;
}

/**
 * Queue on the capture lock until acquired or `timeoutMs` elapses (then
 * `CaptureLockTimeoutError`, which the CLI turns into exit 75). State transitions surface
 * through `onState` so the runner can print lock visibility either way.
 */
export async function acquireCaptureLock(options: IAcquireCaptureLockOptions): Promise<ICaptureLease> {
  const lockRoot = options.lockRoot ?? defaultCaptureLockRoot();
  const lockDir = lockDirOf(lockRoot);
  const queueDir = queueDirOf(lockRoot);
  const alive = options.isProcessAlive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = now() + options.timeoutMs;

  await mkdir(lockRoot, { recursive: true });
  await mkdir(queueDir, { recursive: true });
  const waiterPath = join(queueDir, `${pid}.json`);
  await writeFile(waiterPath, `${JSON.stringify({ pid, queuedAt: new Date().toISOString() })}\n`);
  try {
    for (;;) {
      try {
        await mkdir(lockDir);
        await writeHolderAtomic(lockDir, pid, options.command, new Date(now()).toISOString());
        await rm(waiterPath, { force: true });
        options.onState?.({ mode: "held", queueDepth: await countOtherWaiters(queueDir, pid, alive) });
        return {
          release: () => releaseLease({ lockDir, pid, waiterPath }),
        };
      } catch (error) {
        if (!isLockExistsError(error)) throw error;
      }
      const holder = readHolder(lockDir);
      if (holder === undefined || !alive(holder.pid)) {
        // Dead or unreadable holder: the lock is stale, so steal it — but keep the deadline
        // honest here too; a steal that keeps losing the race must time out, not spin.
        if (now() >= deadline) {
          throw new CaptureLockTimeoutError(
            holder === undefined ? "an unidentifiable stale holder" : holderSummary(holder),
            await countOtherWaiters(queueDir, pid, alive),
            options.timeoutMs,
          );
        }
        await rm(join(lockDir, HOLDER_FILE), { force: true }).catch(() => undefined);
        await removeEmptyDir(lockDir);
      } else if (now() >= deadline) {
        const queueDepth = await countOtherWaiters(queueDir, pid, alive);
        throw new CaptureLockTimeoutError(holderSummary(holder), queueDepth, options.timeoutMs);
      } else {
        options.onState?.({
          holderSummary: holderSummary(holder),
          mode: "waiting",
          queueDepth: await countOtherWaiters(queueDir, pid, alive),
        });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
    }
  } catch (error) {
    await rm(waiterPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function releaseLease(state: { lockDir: string; pid: number; waiterPath: string }): Promise<void> {
  // Only dismantle the lease that is ours; a stolen-back lock must keep its real holder.
  const holder = readHolder(state.lockDir);
  if (holder !== undefined && holder.pid === state.pid) {
    await rm(join(state.lockDir, HOLDER_FILE), { force: true }).catch(() => undefined);
    await removeEmptyDir(state.lockDir);
  }
  await rm(state.waiterPath, { force: true }).catch(() => undefined);
}

async function writeHolderAtomic(lockDir: string, pid: number, command: string | undefined, startedAt: string): Promise<void> {
  const record: ILockHolderRecord = { ...(command === undefined ? {} : { command }), pid, startedAt };
  const finalPath = join(lockDir, HOLDER_FILE);
  const stagingDir = await mkdtemp(join(lockDir, ".holder-"));
  const stagingPath = join(stagingDir, HOLDER_FILE);
  await writeFile(stagingPath, `${JSON.stringify(record)}\n`);
  await rename(stagingPath, finalPath);
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
}

async function countOtherWaiters(queueDir: string, ownPid: number, isProcessAlive: (pid: number) => boolean): Promise<number> {
  let names: string[];
  try {
    names = await readdir(queueDir);
  } catch {
    return 0;
  }
  let depth = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number.parseInt(name.replace(/\.json$/u, ""), 10);
    if (pid === ownPid) continue;
    if (Number.isInteger(pid) && !isProcessAlive(pid)) {
      await rm(join(queueDir, name), { force: true }).catch(() => undefined);
      continue;
    }
    depth += 1;
  }
  return depth;
}

/** Removes the lock directory only when it is genuinely empty; `fs.rm` refuses directories without `recursive`. */
async function removeEmptyDir(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch {
    // Non-empty or already gone — either way someone else owns the next move.
  }
}

function isLockExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function holderSummary(holder: ILockHolderRecord): string {
  return holder.command === undefined || holder.command.length === 0
    ? `pid ${holder.pid}`
    : `pid ${holder.pid} (${holder.command})`;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
