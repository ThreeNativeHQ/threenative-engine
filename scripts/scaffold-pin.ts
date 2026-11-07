/**
 * Rewrites the scaffold pins: two hashes per kit, `shared` and `kit`.
 *
 * A re-pin is a deliberate act, so this prints which bucket moved for which kit and why it can only
 * be one of them — a shared edit (agent-docs, agent-files, template-assets, core's tables, the shared
 * render sources) moves `shared` in every kit that ships the same input; a kit edit moves one `kit`.
 * `--check` writes nothing and exits 1 when a pin is stale, which is what a lane can run.
 *
 *   pnpm scaffold:pin            rewrite the pins in packages/create-threenative/__tests__/scaffold.spec.ts
 *   pnpm scaffold:pin --check    print the stale pins and exit 1
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldTreeBuckets } from "../packages/create-threenative/__tests__/scaffold-tree.js";
import { createProject, templateRoot } from "../packages/create-threenative/src/index.js";
import { templateNames } from "./lib/repo-inventory.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = path.join(REPO, "packages", "create-threenative", "__tests__", "scaffold.spec.ts");
const BEGIN = "// scaffold-pin:begin";
const END = "// scaffold-pin:end";

export interface IScaffoldPin {
  readonly shared: string;
  readonly kit: string;
}

/** Reads the pins a spec carries, so a re-pin compares against what ships rather than a fresh file. */
export function readPins(source: string): Readonly<Record<string, IScaffoldPin>> {
  const block = source.slice(source.indexOf(BEGIN), source.indexOf(END));
  const pins: Record<string, IScaffoldPin> = {};
  // One hash per line: a single-line row is longer than the formatter's width, and the formatter
  // would wrap it into something this reader no longer recognises.
  // One hash per line, and the key quoted only when it has to be: a single-line row is longer than
  // the formatter's width, and the formatter unquotes a plain identifier, so this reads both forms.
  for (const [, quoted, bare, shared, contents] of block.matchAll(
    /^ {2}(?:"([^"]+)"|([a-z][a-z0-9-]*)): \{\n {4}shared: "([0-9a-f]{64})",\n {4}kit: "([0-9a-f]{64})",\n {2}\},$/gmu,
  )) {
    const kit = quoted ?? bare;
    if (kit === undefined || shared === undefined || contents === undefined) continue;
    pins[kit] = { kit: contents, shared };
  }
  return pins;
}

/** The table text the spec carries, one row per kit. */
export function formatPins(pins: Readonly<Record<string, IScaffoldPin>>): string {
  return Object.entries(pins)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([kit, pin]) =>
        `  ${/^[a-z][a-z0-9]*$/u.test(kit) ? kit : JSON.stringify(kit)}: {\n    shared: "${pin.shared}",\n    kit: "${pin.kit}",\n  },`,
    )
    .join("\n");
}

async function measure(): Promise<Readonly<Record<string, IScaffoldPin>>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "threenative-scaffold-pin-"));
  try {
    const pins: Record<string, IScaffoldPin> = {};
    for (const template of templateNames()) {
      const { target } = await createProject({ install: false, target: template, template }, root);
      const buckets = await scaffoldTreeBuckets(target, template, templateRoot());
      pins[template] = { kit: buckets.kit, shared: buckets.shared };
    }
    return pins;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const source = await readFile(SPEC, "utf8");
  const began = source.indexOf(BEGIN);
  const ended = source.indexOf(END);
  if (began === -1 || ended === -1)
    throw new Error(`TN_SCAFFOLD_PIN: ${path.relative(REPO, SPEC)} carries no pin block.`);
  const previous = readPins(source);
  const measured = await measure();
  const kits = Object.keys(measured).sort();
  const missing = kits.filter((kit) => previous[kit] === undefined);
  const moved = kits.filter(
    (kit) =>
      previous[kit] !== undefined &&
      (previous[kit].shared !== measured[kit]?.shared || previous[kit].kit !== measured[kit]?.kit),
  );
  const stale = [...missing, ...moved];
  for (const kit of stale) {
    const before = previous[kit];
    const after = measured[kit];
    if (after === undefined) continue;
    const which =
      before === undefined
        ? "new kit"
        : before.shared === after.shared
          ? "kit"
          : before.kit === after.kit
            ? "shared"
            : "shared and kit";
    process.stdout.write(`stale ${kit}: ${which}\n`);
  }
  // A pin that moved for every kit moved on a shared input, and the running kitting says so: one
  // line the operator can read instead of sixteen.
  if (stale.length === kits.length && kits.length > 1) {
    process.stdout.write(
      "every kit moved: a shared input changed (agent-files, template-assets, core's tables)\n",
    );
  }
  if (check) {
    process.stdout.write(
      stale.length === 0
        ? "scaffold pins are current\n"
        : `${String(stale.length)} stale scaffold pin(s); run \`pnpm scaffold:pin\`\n`,
    );
    return stale.length === 0 ? 0 : 1;
  }
  const table = `\n${formatPins(measured)}\n`;
  // `ended` points at the marker's own text, so the line's indent has to stay in front of it or
  // `biome format` and this tool would rewrite each other forever.
  const indentStart = source.lastIndexOf("\n", began) + 1;
  const indent = source.slice(indentStart, began);
  await writeFile(SPEC, source.slice(0, began) + BEGIN + table + indent + source.slice(ended));
  process.stdout.write(
    `scaffold pins: ${String(kits.length)} kits, ${String(stale.length)} moved\n`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
