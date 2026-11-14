import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The built files a bake needs; their oldest write is when this package was last built. */
const ENTRIES = ["index.js", "kit.js", "mcp/cook-child.js", "mcp/server.js"] as const;

/** Every TypeScript file under `directory`, recursively. */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(absolute, found);
    else if (entry.name.endsWith(".ts")) found.push(absolute);
  }
  return found;
}

const written = (file: string): number => statSync(file).mtimeMs;

/**
 * Fails closed when this package's own `dist` is older than its `src` (PRD-886, owner 2026-11-13).
 *
 * Every bake imports the built package, never the source, so an edit since the last build cooks the
 * previous world and reads as "my edit did nothing". A published install has no `src` beside `dist`,
 * and a checkout with no `dist` is already failing elsewhere, so both pass silently: only a real
 * stale pair stops, naming the one command that rebuilds it.
 *
 * @param root  the package root; the built file's own location by default
 */
export function assertDistFresh(root?: string): void {
  const packageRoot = root ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = join(packageRoot, "src");
  if (!existsSync(source)) return;
  const built = ENTRIES.map((entry) => join(packageRoot, "dist", entry));
  if (!built.every((file) => existsSync(file))) return;
  const oldestBuild = Math.min(...built.map(written));
  const newestSource = Math.max(...sourceFiles(source).map(written));
  if (newestSource <= oldestBuild) return;
  throw new Error(
    "terrain: the built package is older than packages/terrain/src, so this bake would cook the previous world. " +
      "Run: pnpm --filter @threenative/terrain build",
  );
}
