import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const ENTITY_LINE_LIMIT = 80;
// The one core file that may read globals a dedicated worker lacks (PRD-752).
export const HOST_LAYER = "packages/core/src/platform.ts";

const BANNED_ENTITY_TOKENS = /\b(?:archetype|createQuery|defineComponent|System|Component)\b/gu;
// The Academy's licence text, which the ACES curve in this file must keep, uses the English words "System" and "Components".
const ENTITY_TOKEN_EXEMPT_FILES: ReadonlySet<string> = new Set([
  "packages/core/src/look/filmic-tone-mapping.ts",
]);
const CORE_SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const RENDER_EXTENSIONS = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);

// A template's `src/render/` stays portable: it must not reach into the framework for anything
// that decides how the game looks. The spectral exceptions run a simulation and draw nothing;
// meshes, materials, colours and tessellation stay in the game.
// `SpectralOcean` is the shape: it inverse-transforms cascaded wave spectra on the GPU into a
// displacement buffer, and the game builds every visible thing that reads it.
//
// The spectrum's shape is the game's too: `SpectralOcean` takes an optional `energy(kx, kz)` curve
// (and a `capillaryWavenumber`), and falls back to `phillipsEnergy` only when the game gives none.
// A game wanting JONSWAP or a stylised swell writes it in `src/render/`, not in package code.
// Everything around it is the game's: the options carry no defaults at all and the constructor
// throws on each missing number.
//
// PRD-723 also admits the owner-approved shared WorldEnvironment, preset and meter plumbing,
// including their named type re-exports. Games keep named look overrides on the same objects.
//
// Adding another name here needs the same proof: the game must be able to change the appearance
// without editing package code. A symbol that picks a material, a colour or a timing curve
// belongs in `src/render/` as generated source instead.
//
// The look's engine default is the one exception that does decide appearance (AGENTS.md rule 3,
// owner 2026-10-22: a scene with no look options gets the stock Unreal 5.8.3 look). A kit that
// takes that default imports the chain and its tiers from core in `postprocessing.ts` and
// `quality.ts` instead of vendoring them; every option stays overridable from the kit's own
// `quality.ts`, so the game can still change the look completely without editing package code.
const RENDER_PORTABLE_CORE_SYMBOLS: ReadonlySet<string> = new Set([
  "IWorldEnvironmentOptions",
  "OutputRenderer",
  "QualityTier",
  "WorldEnvironment",
  "qualityPreset",
  "qualityTiers",
  "ISpectralOceanCascade",
  "ISpectralOceanHeight",
  "ISpectralOceanOptions",
  "SpectralOcean",
  "exposureSettings",
  "IExposureSettings",
  "AutoExposureNode",
  "ChainStage",
  "IWorldEnvironmentStageContext",
]);

const FRAMEWORK_IMPORT =
  /(?:import\s+(?:type\s+)?|export\s+type\s+)\{([^}]*)\}\s+from\s+["']@threenative\/([^"']+)["'];?/gu;

function importedNames(clause: string): readonly string[] {
  return clause
    .split(",")
    .map(
      (entry) =>
        entry
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0]
          ?.trim() ?? "",
    )
    .filter((name) => name.length > 0);
}

/**
 * Removes allowed framework imports and named type re-exports. Whatever `@threenative/` text
 * survives is a portability violation — a wildcard import, a dynamic one, a package other than
 * core, or a named symbol that is not on the list above.
 */
function withoutPortableImports(source: string): string {
  return source.replaceAll(FRAMEWORK_IMPORT, (statement, clause: string, specifier: string) => {
    if (specifier !== "core") return statement;
    const names = importedNames(clause);
    if (names.length === 0) return statement;
    return names.every((name) => RENDER_PORTABLE_CORE_SYMBOLS.has(name)) ? "" : statement;
  });
}

async function filesUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else files.push(file);
  }
  return files;
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

async function checkEntityRegistry(root: string): Promise<string[]> {
  const file = path.join(root, "packages/core/src/entities.ts");
  const findings: string[] = [];
  if (!existsSync(file)) {
    findings.push(`TN_CORE_ENTITY_FILE_MISSING: ${relative(root, file)}`);
  } else {
    const source = await readFile(file, "utf8");
    const lines = lineCount(source);
    if (lines >= ENTITY_LINE_LIMIT) {
      findings.push(
        `${relative(root, file)} has ${lines} lines; the entity registry must stay fewer than ${ENTITY_LINE_LIMIT} lines`,
      );
    }
  }
  for (const sourceFile of await filesUnder(path.join(root, "packages/core/src"))) {
    if (!CORE_SOURCE_EXTENSIONS.has(path.extname(sourceFile))) continue;
    if (ENTITY_TOKEN_EXEMPT_FILES.has(relative(root, sourceFile))) continue;
    const source = await readFile(sourceFile, "utf8");
    for (const [lineIndex, sourceLine] of source.split(/\r?\n/u).entries()) {
      for (const match of sourceLine.matchAll(BANNED_ENTITY_TOKENS)) {
        findings.push(
          `${relative(root, sourceFile)}:${lineIndex + 1} uses banned entity-registry token '${match[0]}'`,
        );
      }
    }
  }
  return findings;
}

async function checkScaffoldHygiene(root: string): Promise<string[]> {
  const templateRoot = path.join(root, "packages/create-threenative/templates");
  if (!existsSync(templateRoot)) return [];
  const findings: string[] = [];
  const templates = (await readdir(templateRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const template of templates) {
    const templateRootPath = path.join(templateRoot, template.name);
    const manifest = path.join(templateRootPath, "package.json");
    if (existsSync(manifest) && (await readFile(manifest, "utf8")).includes("catalog:")) {
      findings.push(
        `${relative(root, manifest)} contains catalog:; generated manifests need real versions`,
      );
    }
    const renderRoot = path.join(templateRootPath, "src/render");
    for (const file of await filesUnder(renderRoot)) {
      if (!RENDER_EXTENSIONS.has(path.extname(file))) continue;
      const source = withoutPortableImports(await readFile(file, "utf8"));
      if (source.includes("@threenative/")) {
        findings.push(
          `${relative(root, file)} imports @threenative/; render source must stay portable`,
        );
      }
    }
    if (template.name !== "starter") continue;
    const lighting = path.join(renderRoot, "lighting.ts");
    if (!existsSync(lighting))
      findings.push(`${relative(root, lighting)} is required by scaffold hygiene`);
  }
  return findings;
}

async function checkBuiltScaffold(root: string): Promise<string[]> {
  const directory = path.join(root, "examples/abyss-framework/dist");
  if (!existsSync(directory)) return [];
  const findings: string[] = [];
  for (const file of await filesUnder(directory)) {
    const source = await readFile(file, "utf8");
    if (/DebugOverlay|__THREENATIVE__/u.test(source)) {
      findings.push(`${relative(root, file)} contains DebugOverlay or __THREENATIVE__`);
    }
  }
  return findings;
}

function deepestNodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let node: ts.Node = sourceFile;
  for (;;) {
    let next: ts.Node | undefined;
    for (const child of node.getChildren(sourceFile)) {
      if (child.pos <= position && position < child.end) {
        next = child;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

export async function checkWorkerGlobals(root: string): Promise<string[]> {
  const directory = path.join(root, "packages/core/src");
  if (!existsSync(directory)) return [];
  const files = (await filesUnder(directory)).filter((file) =>
    CORE_SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.webworker.d.ts"],
    types: [],
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  });
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const relativePath = relative(root, file);
    if (relativePath === HOST_LAYER) continue;
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (![2304, 2552, 2584].includes(diagnostic.code) || diagnostic.start === undefined) continue;
      if (isTypePosition(deepestNodeAt(sourceFile, diagnostic.start))) continue;
      const name = sourceFile.text.slice(
        diagnostic.start,
        diagnostic.start + (diagnostic.length ?? 0),
      );
      const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      const finding = `${relativePath}:${line} reads '${name}', which a worker does not have; reach it through ${HOST_LAYER}`;
      if (seen.has(finding)) continue;
      seen.add(finding);
      findings.push(finding);
    }
  }
  return findings;
}

export async function checkCoreBoundary(root = process.cwd()): Promise<readonly string[]> {
  return [
    ...(await checkEntityRegistry(root)),
    ...(await checkScaffoldHygiene(root)),
    ...(await checkBuiltScaffold(root)),
    ...(await checkWorkerGlobals(root)),
  ];
}

async function main(): Promise<void> {
  const findings = await checkCoreBoundary();
  if (findings.length > 0) {
    console.error(
      `TN_CORE_BOUNDARY_FAILED:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("core boundary, scaffold hygiene and worker globals passed");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
