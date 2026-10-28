import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { planKitContract } from "../packages/playtest/src/kit-contract.js";
import { loadKitContract } from "./kit-contract.js";

/**
 * Writes one kit contract row's scenario into a scaffolded kit's playtests, so a CI job that runs the
 * kit's own scenarios runs the row too (PRD-748: `engine-cost` in template-nonvisual, every PR).
 * A kit that opts out prints its reason and gets no file; an undeclared row throws, as the sweep does.
 *
 *   tsx scripts/kit-contract-row.ts <row> <kit> <playtests directory>
 */
export async function writeKitContractRow(
  row: string,
  kit: string,
  directory: string,
): Promise<string | undefined> {
  const verdict = planKitContract(await loadKitContract(), [kit]).find(
    (entry) => entry.row === row,
  );
  if (verdict === undefined) throw new Error(`TN_KIT_CONTRACT_ROWS names no such row: ${row}`);
  if (verdict.kind === "opt-out") {
    process.stdout.write(`${kit} opts out of ${row}: ${verdict.reason}\n`);
    return undefined;
  }
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `contract-${row}.playtest.json`);
  await writeFile(file, `${JSON.stringify(verdict.scenario, null, 2)}\n`);
  process.stdout.write(`${kit}: wrote ${file}\n`);
  return file;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith("kit-contract-row.ts")
) {
  const [row, kit, directory] = process.argv.slice(2);
  if (row === undefined || kit === undefined || directory === undefined) {
    process.stderr.write(
      "usage: tsx scripts/kit-contract-row.ts <row> <kit> <playtests directory>\n",
    );
    process.exit(2);
  }
  await writeKitContractRow(row, kit, directory);
}
