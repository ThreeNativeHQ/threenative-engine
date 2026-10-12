/**
 * The native-stub ledger: every symbol the native engine answers with a stub or mock instead of a
 * real binding. The owner forbids stubs in the shipped engine, so the ledger starts empty and a
 * non-empty one blocks default promotion (PRD-533) and the JS engine's deletion (PRD-535).
 *
 *   pnpm tsx packages/three-native/scripts/native-stubs.ts --gate   # exits 1 while any entry remains
 *
 * `native-stubs.spec.ts` checks the ledger's shape and pins its size on every test run.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface INativeStub {
  /** The native bundler's refusal, `specifier:name`, e.g. `three/webgpu:TempNode`. */
  readonly symbol: string;
  /** The PRD that replaces the stub with a binding. */
  readonly prd: string;
  readonly reason: string;
}

export interface INativeStubLedger {
  readonly entries: readonly INativeStub[];
}

export function readNativeStubLedger(file: string): INativeStubLedger {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  const entries = (value as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries))
    throw new Error(`TN_NATIVE_STUBS_INVALID: ${file} has no entries array`);
  return { entries: entries as INativeStub[] };
}

function prdFiles(root: string): string[] {
  return readdirSync(path.join(root, "docs/PRDs"), { recursive: true, encoding: "utf8" });
}

/** Shape, ownership and size problems; empty when the ledger is acceptable to commit. */
export function ledgerProblems(
  ledger: INativeStubLedger,
  committedCount: number,
  root: string,
): string[] {
  const files = prdFiles(root);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { symbol, prd, reason } of ledger.entries) {
    if (!/^[^\s:]+:[\w$*]+$/u.test(symbol ?? ""))
      problems.push(`${symbol}: symbol is not a bundler refusal (\`specifier:name\`)`);
    if (!/^PRD-\d+$/u.test(prd ?? ""))
      problems.push(`${symbol}: names no PRD (expected PRD-<number>)`);
    else {
      const owners = files.filter((file) => path.basename(file).startsWith(`${prd}-`));
      if (owners.length === 0) problems.push(`${symbol}: ${prd} has no file under docs/PRDs`);
      else if (owners.every((file) => file.split(path.sep)[0] === "done"))
        problems.push(`${symbol}: ${prd} is done; its stub outlived it`);
    }
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(`${symbol}: names no reason`);
    if (seen.has(symbol)) problems.push(`${symbol}: listed more than once`);
    seen.add(symbol);
  }
  if (ledger.entries.length > committedCount)
    problems.push(
      `ledger holds ${ledger.entries.length} entries, above the committed ${committedCount}: lower it, or raise COMMITTED_STUB_COUNT in the same diff`,
    );
  return problems;
}

/** The promotion and deletion gate: any entry at all blocks it. */
export function gateProblems(ledger: INativeStubLedger): string[] {
  return ledger.entries.map(
    ({ symbol, prd, reason }) => `TN_NATIVE_STUBS_PRESENT: ${symbol} (${prd}: ${reason})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--gate") throw new Error("Usage: native-stubs.ts --gate");
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../api/native-stubs.json",
  );
  const problems = gateProblems(readNativeStubLedger(file));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
  else console.log("native stub ledger empty: no shipped engine symbol is a stub.");
}
