import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Rule } from "eslint";

const ARCHIVE = /\.zip$/iu;
const MEDIA = /\.(?:glb|gltf|png|jpe?g|webp|ktx2|hdr|exr|wav|ogg|mp3|ttf|otf|woff2?)$/iu;
const LOD = /-lod\d+\.(?:glb|gltf)$/iu;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|css|html)$/iu;
const DEFAULT_ENTRIES = ["src/main.ts", "src/game.ts", "src/index.ts"] as const;

interface IUnusedAssetsOptions {
  readonly entry?: string;
  readonly root?: string;
}

interface IAssetScan {
  readonly archives: string[];
  readonly media: string[];
}

function isIgnoredAsset(rel: string): boolean {
  return rel.startsWith("downloads/acquisitions/") || LOD.test(rel);
}

function walkAssets(dir: string, rel: string, out: IAssetScan): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAssets(full, next, out);
      continue;
    }
    if (isIgnoredAsset(next)) continue;
    if (ARCHIVE.test(entry.name)) out.archives.push(next);
    else if (MEDIA.test(entry.name)) out.media.push(next);
  }
}

function walkSourceFiles(dir: string, chunks: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, chunks);
      continue;
    }
    if (!SOURCE_FILE.test(entry.name) || entry.name === "assets.manifest.json") continue;
    try {
      chunks.push(readFileSync(full, "utf8"));
    } catch {
      // Unreadable file does not count as an asset reference.
    }
  }
}

function collectSourceText(root: string): string {
  const chunks: string[] = [];
  walkSourceFiles(path.join(root, "src"), chunks);
  walkSourceFiles(path.join(root, "public"), chunks);
  for (const single of ["index.html", "threenative.config.ts"]) {
    const file = path.join(root, single);
    if (existsSync(file) && statSync(file).isFile()) {
      chunks.push(readFileSync(file, "utf8"));
    }
  }
  return chunks.join("\n");
}

function firstSourceFile(root: string): string | undefined {
  const srcDir = path.join(root, "src");
  if (!existsSync(srcDir)) return undefined;
  const candidates = readdirSync(srcDir, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => /\.[cm]?[jt]sx?$/u.test(entry))
    .sort();
  return candidates[0] === undefined ? undefined : path.join(srcDir, candidates[0]);
}

function resolveTargetEntry(root: string, explicitEntry?: string): string | undefined {
  if (explicitEntry !== undefined) return path.resolve(root, explicitEntry);
  for (const candidate of DEFAULT_ENTRIES) {
    const resolved = path.join(root, candidate);
    if (existsSync(resolved)) return resolved;
  }
  return firstSourceFile(root);
}

/** Errors on downloaded or leftover files in `assets/` that no game source references, so agents
 * either wire every acquired model/texture/audio asset into the scene or remove dead files. */
export const noUnusedAssets: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          entry: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unused:
        "Unused asset '{{path}}' is never referenced by src/, public/, or threenative.config.ts. Wire it into the live game or delete it.",
      archive:
        "Leftover archive '{{path}}' under assets/. Unpack only needed files outside archives and delete the .zip file.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as IUnusedAssetsOptions;
    const root = options.root;
    if (root === undefined || root === "") return {};
    const assetsDir = path.join(root, "assets");
    if (!existsSync(assetsDir)) return {};
    const targetEntry = resolveTargetEntry(root, options.entry);
    if (targetEntry === undefined || path.resolve(context.filename) !== path.resolve(targetEntry)) {
      return {};
    }
    const scan: IAssetScan = { archives: [], media: [] };
    walkAssets(assetsDir, "", scan);
    if (scan.archives.length === 0 && scan.media.length === 0) return {};

    const sourceText = scan.media.length === 0 ? "" : collectSourceText(root);
    const visitor: Rule.RuleListener = {};
    // ESLint selects visitors by AST node type name, so the key cannot be camelCase.
    visitor.Program = (node) => {
      for (const rel of scan.archives.sort()) {
        context.report({ node, messageId: "archive", data: { path: `assets/${rel}` } });
      }
      for (const rel of scan.media.sort()) {
        if (sourceText.includes(rel)) continue;
        context.report({ node, messageId: "unused", data: { path: `assets/${rel}` } });
      }
    };
    return visitor;
  },
};
