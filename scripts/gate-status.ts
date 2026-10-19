import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type IWorktreeLease,
  type IWorktreeRecord,
  assessWorktreeSnapshot,
  worktreeFromLease,
} from "./worktree-lifecycle.js";

export const GATE_STATUS_SCHEMA_VERSION = 1;
export const GATE_STALE_AFTER_MS = 30_000;
export const GATE_CLOCK_SKEW_MS = 5_000;
export const DEFAULT_GATE_STATUS_PATH = path.resolve(process.cwd(), "artifacts/gates/status.json");

export type GatePhaseState = "failed" | "running" | "succeeded";

export interface IGateArtifact {
  identity: string;
  path: string;
  sha256?: string;
}

export interface IGateTerminalResult {
  exitCode: number;
  finishedAt: string;
  state: Exclude<GatePhaseState, "running">;
}

export interface IGateStatusRecord {
  artifact: IGateArtifact;
  command: string;
  exitCode: number | null;
  finishedAt: string | null;
  heartbeatAt: string;
  lease: IWorktreeLease;
  owner: string;
  ownerPid: number;
  phase: string;
  pid: number;
  runId: string;
  schemaVersion: number;
  startedAt: string;
  state: GatePhaseState;
  statusPath: string;
  terminalResult: IGateTerminalResult | null;
  worktree: IWorktreeRecord;
}

export interface IGateStatusStart {
  artifact: IGateArtifact;
  command: string;
  lease: IWorktreeLease;
  owner: string;
  ownerPid: number;
  phase: string;
  pid: number;
  runId: string;
  statusPath: string;
  worktree: IWorktreeRecord;
}

export interface IGateStatusIdentity {
  owner: string;
  ownerPid: number;
  phase: string;
  pid: number;
  runId: string;
}

export interface IGateStatusReadOptions {
  allowStale?: boolean;
  currentWorktree?: IWorktreeRecord;
  expectedLease?: IWorktreeLease;
  isOwnerAlive?: (pid: number) => boolean;
  now?: Date;
  staleAfterMs?: number;
}

export interface IGateStatusFinish extends IGateStatusIdentity {
  exitCode: number;
}

export class GateStatusError extends Error {
  readonly code = "TN_GATE_STATUS_INVALID";

  constructor(reason: string) {
    super(`RED observed: invalid or stale gate status — ${reason}`);
    this.name = "GateStatusError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GateStatusError(`${name} is missing or invalid`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new GateStatusError(`${name} is invalid`);
  return value;
}

function requiredPid(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new GateStatusError(`${name} is missing or invalid`);
  }
  return Number(value);
}

function requiredExitCode(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 255) {
    throw new GateStatusError(`${name} is missing or invalid`);
  }
  return Number(value);
}

function parseTime(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (Number.isNaN(Date.parse(result)))
    throw new GateStatusError(`${name} is not an ISO timestamp`);
  return result;
}

function parseWorktree(value: unknown, name: string): IWorktreeRecord {
  if (!isObject(value)) throw new GateStatusError(`${name} is missing or invalid`);
  const branch = optionalString(value.branch, `${name}.branch`);
  return {
    branch,
    head: requiredString(value.head, `${name}.head`),
    path: requiredString(value.path, `${name}.path`),
  };
}

function parseLease(value: unknown): IWorktreeLease {
  if (!isObject(value)) throw new GateStatusError("lease is missing or invalid");
  const branch = optionalString(value.branch, "lease.branch");
  const heartbeatAt = optionalString(value.heartbeatAt, "lease.heartbeatAt");
  const runId = optionalString(value.runId, "lease.runId");
  const lease: IWorktreeLease = {
    branch,
    expectedHead: requiredString(value.expectedHead, "lease.expectedHead"),
    ...(heartbeatAt === undefined
      ? {}
      : { heartbeatAt: parseTime(heartbeatAt, "lease.heartbeatAt") }),
    owner: requiredString(value.owner, "lease.owner"),
    path: requiredString(value.path, "lease.path"),
    phase: requiredString(value.phase, "lease.phase"),
    pid: requiredPid(value.pid, "lease.pid"),
    ...(runId === undefined ? {} : { runId }),
    startedAt: parseTime(value.startedAt, "lease.startedAt"),
  };
  return lease;
}

function parseArtifact(value: unknown): IGateArtifact {
  if (!isObject(value)) throw new GateStatusError("artifact is missing or invalid");
  const sha256 = optionalString(value.sha256, "artifact.sha256");
  return {
    identity: requiredString(value.identity, "artifact.identity"),
    path: requiredString(value.path, "artifact.path"),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function parseTerminalResult(value: unknown): IGateTerminalResult | null {
  if (value === null) return null;
  if (!isObject(value)) throw new GateStatusError("terminalResult is invalid");
  const state = value.state;
  if (state !== "failed" && state !== "succeeded") {
    throw new GateStatusError("terminalResult.state is invalid");
  }
  return {
    exitCode: requiredExitCode(value.exitCode, "terminalResult.exitCode"),
    finishedAt: parseTime(value.finishedAt, "terminalResult.finishedAt"),
    state,
  };
}

function parseState(value: unknown): GatePhaseState {
  if (value !== "failed" && value !== "running" && value !== "succeeded") {
    throw new GateStatusError("state is invalid");
  }
  return value;
}

function parseRecordFields(
  value: Record<string, unknown>,
  state: GatePhaseState,
): IGateStatusRecord {
  const terminalResult = parseTerminalResult(value.terminalResult);
  const exitCode = value.exitCode === null ? null : requiredExitCode(value.exitCode, "exitCode");
  const finishedAt = value.finishedAt === null ? null : parseTime(value.finishedAt, "finishedAt");
  const lease = parseLease(value.lease);
  const worktree = parseWorktree(value.worktree, "worktree");
  const record: IGateStatusRecord = {
    artifact: parseArtifact(value.artifact),
    command: requiredString(value.command, "command"),
    exitCode,
    finishedAt,
    heartbeatAt: parseTime(value.heartbeatAt, "heartbeatAt"),
    lease,
    owner: requiredString(value.owner, "owner"),
    ownerPid: requiredPid(value.ownerPid, "ownerPid"),
    phase: requiredString(value.phase, "phase"),
    pid: requiredPid(value.pid, "pid"),
    runId: requiredString(value.runId, "runId"),
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 0,
    startedAt: parseTime(value.startedAt, "startedAt"),
    state,
    statusPath: requiredString(value.statusPath, "statusPath"),
    terminalResult,
    worktree,
  };
  return record;
}

function validateRecordShape(record: IGateStatusRecord): void {
  if (record.schemaVersion !== GATE_STATUS_SCHEMA_VERSION) {
    throw new GateStatusError(`unsupported schema version '${record.schemaVersion}'`);
  }
  if (record.lease.owner !== record.owner || record.lease.pid !== record.ownerPid) {
    throw new GateStatusError("lease owner does not match status owner");
  }
  const snapshot = assessWorktreeSnapshot(worktreeFromLease(record.lease), record.worktree);
  if (!snapshot.ok) throw new GateStatusError(snapshot.reason ?? "lease does not match worktree");
  if (record.artifact.identity !== `${record.runId}:${record.phase}`) {
    throw new GateStatusError("artifact identity does not match the run and phase");
  }
}

function validateRunningShape(record: IGateStatusRecord): void {
  if (record.exitCode !== null || record.finishedAt !== null || record.terminalResult !== null) {
    throw new GateStatusError("running phase has a terminal result");
  }
}

function validateCompletedShape(record: IGateStatusRecord): void {
  if (record.exitCode === null || record.finishedAt === null || record.terminalResult === null) {
    throw new GateStatusError("terminal phase is missing its result");
  }
  const result = record.terminalResult;
  if (
    result.state !== record.state ||
    result.exitCode !== record.exitCode ||
    result.finishedAt !== record.finishedAt
  ) {
    throw new GateStatusError("terminal result does not match the record");
  }
  if (record.state === "succeeded" && record.exitCode !== 0) {
    throw new GateStatusError("succeeded phase has a non-zero exit code");
  }
  if (record.state === "failed" && record.exitCode === 0) {
    throw new GateStatusError("failed phase has a zero exit code");
  }
}

function validateTerminalShape(record: IGateStatusRecord): void {
  if (record.state === "running") {
    validateRunningShape(record);
    return;
  }
  validateCompletedShape(record);
}

function parseRecord(value: unknown): IGateStatusRecord {
  if (!isObject(value)) throw new GateStatusError("record is not a JSON object");
  const record = parseRecordFields(value, parseState(value.state));
  validateRecordShape(record);
  validateTerminalShape(record);
  return record;
}

function fail(reason: string): never {
  throw new GateStatusError(reason);
}

export function isGateStatusStale(
  record: Pick<IGateStatusRecord, "heartbeatAt" | "state" | "ownerPid">,
  options: Pick<IGateStatusReadOptions, "isOwnerAlive" | "now" | "staleAfterMs"> = {},
): boolean {
  if (record.state !== "running") return false;
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? GATE_STALE_AFTER_MS;
  const age = now.getTime() - Date.parse(record.heartbeatAt);
  return age > staleAfterMs || options.isOwnerAlive?.(record.ownerPid) === false;
}

async function validateArtifact(record: IGateStatusRecord): Promise<void> {
  if (record.artifact.sha256 === undefined) return;
  let content: Buffer;
  try {
    content = await readFile(record.artifact.path);
  } catch {
    fail(`artifact '${record.artifact.path}' is missing`);
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== record.artifact.sha256) {
    fail(`artifact '${record.artifact.path}' identity changed`);
  }
}

function validateTimes(record: IGateStatusRecord, options: IGateStatusReadOptions): void {
  const now = (options.now ?? new Date()).getTime();
  const maxFuture = now + GATE_CLOCK_SKEW_MS;
  if (Date.parse(record.startedAt) > maxFuture) fail("startedAt is in the future");
  if (Date.parse(record.heartbeatAt) > maxFuture) fail("heartbeatAt is in the future");
  if (record.finishedAt !== null && Date.parse(record.finishedAt) > maxFuture) {
    fail("finishedAt is in the future");
  }
}

function validateOwnership(record: IGateStatusRecord, options: IGateStatusReadOptions): void {
  if (options.currentWorktree !== undefined) {
    const snapshot = assessWorktreeSnapshot(record.worktree, options.currentWorktree);
    if (!snapshot.ok) fail(snapshot.reason ?? "worktree ownership changed");
  }
  if (options.expectedLease !== undefined) {
    const snapshot = assessWorktreeSnapshot(
      worktreeFromLease(record.lease),
      worktreeFromLease(options.expectedLease),
    );
    if (
      !snapshot.ok ||
      record.lease.owner !== options.expectedLease.owner ||
      record.lease.pid !== options.expectedLease.pid
    ) {
      fail(snapshot.reason ?? "lease ownership changed");
    }
  }
}

async function validateRecord(
  record: IGateStatusRecord,
  options: IGateStatusReadOptions,
): Promise<IGateStatusRecord> {
  validateTimes(record, options);
  validateOwnership(record, options);
  await validateArtifact(record);
  if (isGateStatusStale(record, options)) {
    if (options.allowStale === true) return record;
    fail("heartbeat or phase owner is stale");
  }
  return record;
}

async function readRawStatus(statusPath: string): Promise<IGateStatusRecord> {
  let content: string;
  try {
    content = await readFile(statusPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      fail(`status file '${statusPath}' is missing`);
    }
    fail(`status file '${statusPath}' cannot be read`);
  }
  try {
    return parseRecord(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof GateStatusError) throw error;
    fail(`status file '${statusPath}' is not valid JSON`);
  }
}

export async function readGateStatus(
  statusPath = DEFAULT_GATE_STATUS_PATH,
  options: IGateStatusReadOptions = {},
): Promise<IGateStatusRecord> {
  const resolvedPath = path.resolve(statusPath);
  const record = await readRawStatus(resolvedPath);
  if (path.resolve(record.statusPath) !== resolvedPath) {
    fail("status artifact path changed");
  }
  return validateRecord(record, options);
}

async function writeAtomic(statusPath: string, record: IGateStatusRecord): Promise<void> {
  const resolvedPath = path.resolve(statusPath);
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function assertStatusIdentity(record: IGateStatusRecord, identity: IGateStatusIdentity): void {
  if (
    record.runId !== identity.runId ||
    record.phase !== identity.phase ||
    record.owner !== identity.owner ||
    record.ownerPid !== identity.ownerPid ||
    record.pid !== identity.pid
  ) {
    fail("phase owner or run identity changed");
  }
  if (record.state !== "running") fail("phase is already terminal");
}

function assertStatusPath(record: IGateStatusRecord, statusPath: string): void {
  if (path.resolve(record.statusPath) !== path.resolve(statusPath)) {
    fail("status artifact path changed");
  }
}

export async function startGatePhase(
  input: IGateStatusStart,
  options: { now?: Date } = {},
): Promise<IGateStatusRecord> {
  const now = (options.now ?? new Date()).toISOString();
  const statusPath = path.resolve(input.statusPath);
  const record: IGateStatusRecord = {
    artifact: {
      ...input.artifact,
      path: path.resolve(input.artifact.path),
    },
    command: input.command,
    exitCode: null,
    finishedAt: null,
    heartbeatAt: now,
    lease: input.lease,
    owner: input.owner,
    ownerPid: input.ownerPid,
    phase: input.phase,
    pid: input.pid,
    runId: input.runId,
    schemaVersion: GATE_STATUS_SCHEMA_VERSION,
    startedAt: now,
    state: "running",
    statusPath,
    terminalResult: null,
    worktree: input.worktree,
  };
  parseRecord(record);
  await writeAtomic(statusPath, record);
  return record;
}

export async function heartbeatGatePhase(
  statusPath: string,
  identity: IGateStatusIdentity,
  options: { now?: Date } = {},
): Promise<IGateStatusRecord> {
  const resolvedPath = path.resolve(statusPath);
  const record = await readRawStatus(resolvedPath);
  assertStatusPath(record, resolvedPath);
  assertStatusIdentity(record, identity);
  const next: IGateStatusRecord = {
    ...record,
    heartbeatAt: (options.now ?? new Date()).toISOString(),
  };
  parseRecord(next);
  await writeAtomic(record.statusPath, next);
  return next;
}

export async function finishGatePhase(
  statusPath: string,
  input: IGateStatusFinish,
  options: { now?: Date } = {},
): Promise<IGateStatusRecord> {
  const resolvedPath = path.resolve(statusPath);
  const record = await readRawStatus(resolvedPath);
  assertStatusPath(record, resolvedPath);
  assertStatusIdentity(record, input);
  const finishedAt = (options.now ?? new Date()).toISOString();
  const state: Exclude<GatePhaseState, "running"> = input.exitCode === 0 ? "succeeded" : "failed";
  const next: IGateStatusRecord = {
    ...record,
    exitCode: input.exitCode,
    finishedAt,
    heartbeatAt: finishedAt,
    state,
    terminalResult: { exitCode: input.exitCode, finishedAt, state },
  };
  parseRecord(next);
  await writeAtomic(record.statusPath, next);
  return next;
}

function value(flags: readonly string[], name: string): string {
  const index = flags.indexOf(name);
  if (index < 0 || flags[index + 1] === undefined || flags[index + 1] === "") {
    throw new Error(`gate-status usage: missing ${name}`);
  }
  return flags[index + 1] as string;
}

function optionalValue(flags: readonly string[], name: string): string | undefined {
  const index = flags.indexOf(name);
  if (index < 0) return undefined;
  return flags[index + 1];
}

function integerValue(flags: readonly string[], name: string): number {
  const result = Number.parseInt(value(flags, name), 10);
  if (!Number.isInteger(result) || result <= 0)
    throw new Error(`gate-status usage: invalid ${name}`);
  return result;
}

function nonNegativeIntegerValue(flags: readonly string[], name: string): number {
  const result = Number.parseInt(value(flags, name), 10);
  if (!Number.isInteger(result) || result < 0 || result > 255)
    throw new Error(`gate-status usage: invalid ${name}`);
  return result;
}

function branchValue(flags: readonly string[], name: string): string | undefined {
  const result = optionalValue(flags, name);
  return result === undefined || result.length === 0 ? undefined : result;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command = "read", ...flags] = argv;
  const statusPath = optionalValue(flags, "--status-path") ?? DEFAULT_GATE_STATUS_PATH;
  if (command === "start") {
    const runId = value(flags, "--run-id");
    const phase = value(flags, "--phase");
    const owner = value(flags, "--owner");
    const ownerPid = integerValue(flags, "--owner-pid");
    const pid = integerValue(flags, "--pid");
    const worktreePath = value(flags, "--worktree-path");
    const branch = branchValue(flags, "--branch");
    const head = value(flags, "--head");
    const leaseOwner = optionalValue(flags, "--lease-owner") ?? owner;
    const leasePid =
      optionalValue(flags, "--lease-pid") === undefined
        ? ownerPid
        : integerValue(flags, "--lease-pid");
    const leasePath = optionalValue(flags, "--lease-path") ?? worktreePath;
    const expectedHead = optionalValue(flags, "--expected-head") ?? head;
    const artifactPath = optionalValue(flags, "--artifact-path") ?? statusPath;
    const artifactId = optionalValue(flags, "--artifact-id") ?? `${runId}:${phase}`;
    const now = new Date().toISOString();
    await startGatePhase({
      artifact: { identity: artifactId, path: artifactPath },
      command: value(flags, "--command"),
      lease: {
        branch: branchValue(flags, "--lease-branch") ?? branch,
        expectedHead,
        owner: leaseOwner,
        path: leasePath,
        phase,
        pid: leasePid,
        ...(runId.length === 0 ? {} : { runId }),
        startedAt: now,
      },
      owner,
      ownerPid,
      phase,
      pid,
      runId,
      statusPath,
      worktree: { branch, head, path: worktreePath },
    });
    return;
  }
  if (command === "heartbeat") {
    await heartbeatGatePhase(statusPath, {
      owner: value(flags, "--owner"),
      ownerPid: integerValue(flags, "--owner-pid"),
      phase: value(flags, "--phase"),
      pid: integerValue(flags, "--pid"),
      runId: value(flags, "--run-id"),
    });
    return;
  }
  if (command === "finish") {
    await finishGatePhase(statusPath, {
      exitCode: nonNegativeIntegerValue(flags, "--exit-code"),
      owner: value(flags, "--owner"),
      ownerPid: integerValue(flags, "--owner-pid"),
      phase: value(flags, "--phase"),
      pid: integerValue(flags, "--pid"),
      runId: value(flags, "--run-id"),
    });
    return;
  }
  if (command === "read") {
    process.stdout.write(`${JSON.stringify(await readGateStatus(statusPath), null, 2)}\n`);
    return;
  }
  throw new Error("usage: gate-status.ts <start|heartbeat|finish|read> [options]");
}

if (process.argv[1]?.endsWith("gate-status.ts") === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
