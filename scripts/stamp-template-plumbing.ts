/**
 * Writes the build plumbing every kit copies from one source.
 *
 * A kit's `tsconfig.json` used to be a hand-kept copy: sixteen files, two shapes, and the split
 * between them recorded nowhere. This regenerates each from `packages/create-threenative/src/
 * plumbing.ts` plus the delta the kit's own manifest declares, so whether a kit ships React is the
 * one thing that changes the file.
 *
 *   pnpm stamp:template-plumbing            write every kit's file
 *   pnpm stamp:template-plumbing --check    exit 1 when one differs, writing nothing
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  kitMainDelta,
  kitPlumbingDelta,
  kitViteDelta,
  mainText,
  tsconfigText,
  viteConfigText,
} from "../packages/create-threenative/src/plumbing.js";
import { templateNames } from "./lib/repo-inventory.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(REPO, "packages", "create-threenative", "templates");

/** Every plumbing file this stamp owns, with the text a kit should hold. */
export function plumbingFiles(): readonly { readonly file: string; readonly text: string }[] {
  return templateNames().flatMap((kit) => [
    {
      file: path.join(TEMPLATES, kit, "tsconfig.json"),
      text: tsconfigText(kitPlumbingDelta(kit, TEMPLATES)),
    },
    {
      file: path.join(TEMPLATES, kit, "vite.config.ts"),
      text: viteConfigText(kitViteDelta(kit, TEMPLATES)),
    },
    // A kit whose entry carries a statement of its own keeps it (`kit.json` scaffold.mainHandWritten).
    ...(() => {
      const main = mainText(kitMainDelta(kit, TEMPLATES));
      return main === undefined
        ? []
        : [{ file: path.join(TEMPLATES, kit, "src", "main.ts"), text: main }];
    })(),
  ]);
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const stale: string[] = [];
  for (const { file, text } of plumbingFiles()) {
    // A kit without the file is stale, not a crash: `createProject` writes it for every kit.
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current === text) continue;
    stale.push(path.relative(REPO, file));
    if (!check) writeFileSync(file, text);
  }
  process.stdout.write(
    check
      ? stale.length === 0
        ? "template plumbing is current\n"
        : `${String(stale.length)} stale: ${stale.join(", ")}; run \`pnpm stamp:template-plumbing\`\n`
      : `template plumbing: ${String(stale.length)} file(s) written\n`,
  );
  return check && stale.length > 0 ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
