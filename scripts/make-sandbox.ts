/**
 * Build a sandbox that behaves like a user's machine with ThreeNative installed from npm.
 *
 * The point is context, not packaging. An agent working inside the monorepo can read
 * `packages/*\/src`, `docs/`, every `AGENTS.md` and the charter, and it does — measurably,
 * before writing a line of game code. A user's agent can read none of that: the packages
 * ship `files: ["dist"]`, so the source simply is not on disk.
 *
 * So we pack the packages into tarballs, scaffold outside the monorepo, and install. The
 * sandbox must live outside this repo or it inherits the `AGENTS.md` chain and the pnpm
 * workspace, which is the whole thing we are removing.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  packageArchivePrefix,
  workspaceBuildOrder,
  workspacePackageSourceFlag,
} from "./workspace-packages.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PACKAGE = "create-threenative";
const ARMS = ["framework", "vanilla"] as const;

/** A stable tarball key, derived from the package census rather than another package list. */
function packageKey(name: string): string {
  if (name.startsWith("@threenative/")) return name.slice("@threenative/".length);
  return name.startsWith("threenative-") ? name.slice("threenative-".length) : name;
}

export function sandboxWorkspacePackages(repo = REPO): readonly string[] {
  return workspaceBuildOrder(repo)
    .map(({ name }) => name)
    .filter((name) => name !== CLI_PACKAGE);
}

/** Resolve a package's actual workspace directory; package names do not always match folder names. */
export function sandboxPackageDirectory(name: string, repo = REPO): string {
  const packageEntry = workspaceBuildOrder(repo).find((item) => item.name === name);
  if (packageEntry === undefined)
    throw new Error(`TN_SANDBOX_PACKAGE_MISSING: no workspace package named '${name}'.`);
  return path.relative(repo, packageEntry.directory).replaceAll(path.sep, "/");
}

export const PACKAGES = Object.freeze(sandboxWorkspacePackages().map(packageKey));
type PackageTarball = string;

export type SandboxArm = (typeof ARMS)[number];

export interface SweepManifest {
  readonly arm: SandboxArm;
  readonly genre: string;
  readonly briefHash: string;
  readonly proofHash: string;
  readonly template: string;
  readonly date: string;
  readonly frameworkVersion: string;
  readonly sourceLines: number;
}

interface GenreInput {
  readonly brief: string;
  readonly briefHash: string;
  readonly proofHash: string;
  readonly reference: string;
}

export interface ProofFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface SandboxOptions {
  readonly arm?: SandboxArm;
  readonly bare?: boolean;
  readonly genre: string;
  readonly name?: string;
  readonly out?: string;
  readonly packageTarballs?: Partial<Record<PackageTarball, string>>;
  readonly prepare?: boolean;
  readonly repo?: string;
  readonly install?: boolean;
  readonly template?: string;
}

export interface SandboxResult {
  readonly manifest: SweepManifest;
  readonly out: string;
  /** The one game folder inside the sandbox. Nothing is ever written to the sandbox root. */
  readonly project: string;
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function packedManifest(file: string): Record<string, unknown> {
  const raw = execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" });
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Every path a manifest names under a `types` condition, as a tarball-relative path. */
function declaredTypesPaths(manifest: Record<string, unknown>): readonly string[] {
  const declared = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string") declared.add(value.replace(/^\.\//u, ""));
  };
  add(manifest.types);
  add(manifest.typings);
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [condition, value] of Object.entries(node)) {
      if (condition === "types") add(value);
      else walk(value);
    }
  };
  walk(manifest.exports);
  return [...declared].sort();
}

/**
 * Fail closed when a tarball does not carry the declarations its own manifest promises.
 *
 * `pnpm pack` copies whatever `dist` holds at the moment it runs, and `files: ["dist"]` is an
 * allowlist that cannot notice a file is absent. A tsup rebuild in another lane clears that
 * directory and writes the bundles about eleven seconds before the declarations, so a pack
 * landing inside that window ships every `.js`, no `.d.ts`, and no error at all. The sandbox
 * then installs a package whose `types` entry resolves to nothing: `@threenative/physics`
 * shipped exactly that tarball, and every game importing it typechecked as implicit `any`.
 */
export function assertPackedTypesShipped(file: string): void {
  const declared = declaredTypesPaths(packedManifest(file));
  if (declared.length === 0) return;
  const packed = new Set(
    execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
      .split("\n")
      .flatMap((entry) => (entry.startsWith("package/") ? [entry.slice("package/".length)] : [])),
  );
  const missing = declared.filter((entry) => !packed.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `${file} declares types it does not ship: ${missing.join(", ")}. Rebuild the package and pack again; nothing else may be writing its dist while pnpm pack runs.`,
    );
  }
}

export function assertPackedManifestResolved(file: string): void {
  const manifest = packedManifest(file);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
      continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (
        typeof specifier === "string" &&
        (specifier === "catalog:" || specifier.startsWith("workspace:"))
      ) {
        throw new Error(
          `${file} packs ${field}.${name} as '${specifier}'; use pnpm pack, not npm pack.`,
        );
      }
    }
  }
}

export function readFlag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function isFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function isDirectory(directory: string): boolean {
  return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
}

function assertGenreName(genre: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(genre))
    throw new Error(`Invalid genre '${genre}'; use a lowercase genre slug.`);
}

/**
 * A sandbox holds one game per folder. The name is a plain slug so it cannot escape the sandbox,
 * collide with the hidden package staging, or land the project at the sandbox root — a game dumped
 * at the root leaves no room for the next one and makes `sweep:archive` guess which is which.
 */
export function assertProjectName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error(`Invalid project name '${name}'; use a lowercase slug such as fox-game.`);
}

export function assertSandboxArm(arm: string): asserts arm is SandboxArm {
  if (!ARMS.includes(arm as SandboxArm))
    throw new Error(`Invalid sandbox arm '${arm}'; use framework or vanilla.`);
}

function proofDirectory(repo: string, genre: string): string {
  return path.join(repo, "docs", "benchmark", "genres", genre, "proof");
}

function collectProofFiles(directory: string, root = directory): ProofFile[] {
  if (!isDirectory(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectProofFiles(absolutePath, root);
      if (!entry.isFile() || !entry.name.endsWith(".playtest.json")) return [];
      return [
        {
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
        },
      ];
    });
}

export function sealedProofFiles(repo: string, genre: string): readonly ProofFile[] {
  assertGenreName(genre);
  const files = collectProofFiles(proofDirectory(repo, genre));
  if (files.length === 0) throw new Error(`Genre '${genre}' has no sealed proof scenarios.`);
  return files;
}

export function hashProofFiles(files: readonly ProofFile[]): string {
  if (files.length === 0) throw new Error("Cannot hash an empty sealed proof set.");
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sealedProofHash(repo: string, genre: string): string {
  return hashProofFiles(sealedProofFiles(repo, genre));
}

export function resolveGenre(repo: string, genre: string): GenreInput {
  assertGenreName(genre);
  const directory = path.join(repo, "docs", "benchmark", "genres", genre);
  const brief = path.join(directory, "brief.md");
  if (!isFile(brief)) throw new Error(`Genre '${genre}' is missing its required brief: ${brief}`);
  const reference = path.join(directory, "reference.png");
  if (!isFile(reference))
    throw new Error(`Genre '${genre}' is missing its required reference image: ${reference}`);
  const briefHash = createHash("sha256").update(fs.readFileSync(brief)).digest("hex");
  const proofHash = sealedProofHash(repo, genre);
  return { brief, briefHash, proofHash, reference };
}

export function readManifest(file: string): SweepManifest {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SweepManifest>;
  const required = [
    "arm",
    "genre",
    "briefHash",
    "proofHash",
    "template",
    "date",
    "frameworkVersion",
    "sourceLines",
  ] as const;
  for (const key of required) {
    if (value[key] === undefined || value[key] === "")
      throw new Error(`Invalid sweep manifest '${file}': missing ${key}.`);
  }
  for (const key of ["briefHash", "proofHash", "template", "frameworkVersion"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "")
      throw new Error(`Invalid sweep manifest '${file}': ${key} must be a non-empty string.`);
  }
  if (typeof value.arm !== "string")
    throw new Error(`Invalid sweep manifest '${file}': arm must be framework or vanilla.`);
  assertSandboxArm(value.arm);
  if (typeof value.genre !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.genre))
    throw new Error(`Invalid sweep manifest '${file}': genre must be a lowercase slug.`);
  if (
    typeof value.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.date)
  )
    throw new Error(`Invalid sweep manifest '${file}': date must be an ISO timestamp.`);
  if (
    typeof value.sourceLines !== "number" ||
    !Number.isInteger(value.sourceLines) ||
    value.sourceLines < 0
  )
    throw new Error(
      `Invalid sweep manifest '${file}': sourceLines must be a non-negative integer.`,
    );
  return value as SweepManifest;
}

function sameRun(left: SweepManifest, right: SweepManifest): boolean {
  return (
    left.arm === right.arm &&
    left.genre === right.genre &&
    left.briefHash === right.briefHash &&
    left.proofHash === right.proofHash &&
    left.date === right.date
  );
}

export function isArchived(manifest: SweepManifest, repo = REPO): boolean {
  if (!isDirectory(path.join(repo, "docs", "benchmark", "sweeps"))) return false;
  for (const entry of fs.readdirSync(path.join(repo, "docs", "benchmark", "sweeps"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(repo, "docs", "benchmark", "sweeps", entry.name, "sweep.json");
    if (!isFile(manifestFile)) continue;
    try {
      if (sameRun(readManifest(manifestFile), manifest)) return true;
    } catch {
      // An unrelated malformed archive cannot authorize wiping this run.
    }
  }
  return false;
}

/**
 * A sandbox holds one game per folder, so only the folder this run will write is wiped; games from
 * earlier sweeps stay put beside it. A game at the sandbox root is the old layout and blocks that —
 * there is no folder to scope the wipe to, and the sealed inputs beside it belong to that build.
 */
function assertCanWipe(out: string, project: string, repo: string): void {
  if (!fs.existsSync(out)) return;
  if (!isDirectory(out)) throw new Error(`Sandbox target '${out}' is not a directory.`);
  if (isDirectory(path.join(out, "src")))
    throw new Error(
      `Sandbox root '${out}' holds a game directly. Move it into its own folder (${path.join(out, "<name>")}) with its brief.md, reference.png and sweep.json, or archive it with pnpm sweep:archive.`,
    );
  if (!isDirectory(project)) return;
  // archiveSandbox refuses a project with no src/ as "not built", so demanding an archive here
  // would strand a folder that was created and never scaffolded: neither command could clear it
  // and the next sweep could not start. There is no build to preserve, so nothing is lost.
  if (!isDirectory(path.join(project, "src"))) return;
  const manifestFile = isFile(path.join(project, "sweep.json"))
    ? path.join(project, "sweep.json")
    : path.join(out, "sweep.json");
  if (!isFile(manifestFile)) return;
  let manifest: SweepManifest;
  try {
    manifest = readManifest(manifestFile);
  } catch (error) {
    throw new Error(
      `Refusing to wipe '${project}': it contains an invalid sweep.json. Archive it or remove it manually. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isArchived(manifest, repo))
    throw new Error(
      `Refusing to wipe unarchived build '${project}'. Run pnpm sweep:archive before reusing that name, or pass --name for a new folder.`,
    );
}

function frameworkVersion(repo: string): string {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0)
    throw new Error("Root package.json has no framework version.");
  return packageJson.version;
}

/** Maps a dependency a template declares onto the tarball key that would replace it. */
function tarballKey(dependency: string, repo: string): PackageTarball | undefined {
  const packageNames = new Set([...sandboxWorkspacePackages(repo), CLI_PACKAGE]);
  if (!packageNames.has(dependency)) return undefined;
  return packageKey(dependency);
}

/**
 * A workspace package the template depends on but the sandbox never packed falls through to the
 * registry at install time. Two of them did, and both 404 there, so `./scaffold.sh` died before
 * the run started. Fail here — with the names — rather than in someone else's `pnpm install`.
 */
export function assertTemplateSourcesCovered(
  repo: string,
  template: string,
  tarballs: Partial<Record<PackageTarball, string>>,
): void {
  const manifestPath = path.join(
    repo,
    "packages/create-threenative/templates",
    template,
    "package.json",
  );
  if (!fs.existsSync(manifestPath)) throw new Error(`Unknown template '${template}'.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  // optionalDependencies are excluded on purpose: the native runtime is allowed to be absent,
  // and pnpm drops it rather than failing the install.
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  const uncovered = declared.filter((dependency) => {
    const key = tarballKey(dependency, repo);
    return key !== undefined && tarballs[key] === undefined;
  });
  if (uncovered.length > 0)
    throw new Error(
      `Template '${template}' depends on workspace packages the sandbox did not pack: ${uncovered.join(", ")}. They are not on the registry, so the scaffold would fail at install.`,
    );
}

function vanillaPackageJson(projectName: string, playtestTarball: string): string {
  return `${JSON.stringify(
    {
      name: projectName,
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        typecheck: "tsc --noEmit -p tsconfig.json",
      },
      dependencies: {
        "@threenative/playtest": `file:${playtestTarball}`,
        three: "0.185.1",
      },
      devDependencies: {
        "@types/three": "0.185.3",
        playwright: "1.62.1",
        typescript: "7.0.2",
        vite: "8.2.0",
      },
    },
    null,
    2,
  )}\n`;
}

function writeVanillaScaffold(out: string, playtestTarball: string): void {
  const projectName = path
    .basename(out)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-");
  fs.mkdirSync(path.join(out, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(out, "package.json"),
    vanillaPackageJson(projectName, playtestTarball),
  );
  fs.writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${projectName}</title>\n  </head>\n  <body>\n    <main id="app"></main>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
  );
  fs.writeFileSync(
    path.join(out, "vite.config.ts"),
    'import { defineConfig } from "vite";\n\nexport default defineConfig({});\n',
  );
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["vite/client"],
          strict: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
        },
        include: ["src/**/*.ts", "tests/**/*.ts", "*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(out, "AGENTS.md"),
    `# AGENTS.md — ${projectName}\n\nThis is the vanilla arm of the benchmark. Build the game described in \`brief.md\` and match \`reference.png\`. Use plain Three.js for rendering and gameplay. You may install any npm package you choose, including a physics engine.\n\nThe only ThreeNative package available is the observation bridge. Install it after your scene, camera, renderer, and entities exist. Tick-driven proof scenarios require all five provider hooks:\n\n\`\`\`ts\nimport { installThreePlaytestBridge } from "@threenative/playtest/three";\n\ninstallThreePlaytestBridge({\n  camera,\n  diagnostics: () => [{ label: \"FPS\", value: fps }],\n  entities,\n  fixedStep: (ticks) => {\n    for (let index = 0; index < ticks; index += 1) tick();\n  },\n  tick: () => frame,\n  gameplay: () => ({\n    animation: { player: { clip: "idle", advancedFrames: 1 } },\n    states: { player: "idle", mission: "playing" },\n  }),\n  renderer,\n  resources: { read: () => ({ state: { ...state } }) },\n  scene,\n});\n\`\`\`\n\n\`fixedStep\` advances the simulation once per requested tick, and \`tick\` must be installed with it — installing \`fixedStep\` alone throws at module scope and takes your whole entry file down with it. \`diagnostics\` publishes runtime diagnostics: an entry shaped \`{ label, value }\` with a string, number or boolean value is a readout and never fails a proof, while anything else counts as a runtime error. \`gameplay\` must return both \`animation\` and \`states\` records when the proof asks for runtime animation or state assertions. \`resources.read()\` must expose the generic resource id \`state\` with the current serializable game state. Do not edit or copy the sealed proof scenarios; the sweep runner supplies them at test time.\n`,
  );
}

/**
 * How much of the framework an agent in the sandbox can actually read. Not zero: tsup emits
 * sourcemaps with `sourcesContent`, so the original TypeScript rides along inside dist. A
 * published package leaks exactly the same way, so this reports reality rather than hiding it.
 */
export function sourceLines(root: string): number {
  const packages = path.join(root, "node_modules", "@threenative");
  if (!fs.existsSync(packages)) return 0;
  let total = 0;
  for (const pkg of fs.readdirSync(packages)) {
    const dist = path.join(packages, pkg, "dist");
    if (!fs.existsSync(dist)) continue;
    for (const file of fs.readdirSync(dist)) {
      if (!file.endsWith(".map")) continue;
      const map = JSON.parse(fs.readFileSync(path.join(dist, file), "utf8")) as {
        sourcesContent?: (string | null)[];
      };
      for (const content of map.sourcesContent ?? []) total += content?.split("\n").length ?? 0;
    }
  }
  return total;
}

/**
 * Rename a freshly packed tarball to carry a hash of its own bytes. `pnpm pack` names by version
 * alone, so every sweep produced `threenative-core-0.1.0.tgz` at the same path with different
 * contents, and a package manager is entitled to serve the copy it already has under that
 * identity. The content hash makes each build's tarball a distinct package to install, which is
 * the whole point of re-packing: a sandbox installs the engine as it is now, not as it was.
 */
export function stampTarball(file: string): string {
  const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  const stamped = file.replace(/\.tgz$/, `-${digest}.tgz`);
  fs.renameSync(file, stamped);
  return stamped;
}

export function makeSandbox(options: SandboxOptions): SandboxResult {
  const repo = path.resolve(options.repo ?? REPO);
  const out = path.resolve(repo, options.out ?? "../sandbox");
  const arm = options.arm ?? "framework";
  assertSandboxArm(arm);
  const genre = options.genre;
  const template = options.template ?? "starter";
  const input = resolveGenre(repo, genre);
  const name = options.name ?? `${genre}-game`;
  assertProjectName(name);
  const project = path.join(out, name);

  if (out === repo || out.startsWith(`${repo}${path.sep}`)) {
    throw new Error(
      `Sandbox must live outside the repo, got ${out}. Inside it, the agent inherits every AGENTS.md up to the root plus the pnpm workspace — the bloat this removes.`,
    );
  }
  assertCanWipe(out, project, repo);
  // Keep package staging with the sandbox. It is hidden from the builder and disappears with
  // the sandbox, so repeated runs do not scatter sibling folders through the workspace.
  const staging = path.join(out, ".packages");
  for (const dir of [project, staging]) if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });

  const prepare = options.prepare ?? true;
  // A vanilla fixture with `prepare: false` only needs the bridge tarball path. Keep this
  // lightweight path usable for tests and callers that provide no package manifests; a real
  // prepared run still requires the package census below and fails closed when it is missing.
  const workspaceItems =
    arm === "vanilla" && !prepare
      ? []
      : workspaceBuildOrder(repo).filter(({ name }) => name !== CLI_PACKAGE);
  const selectedWorkspaceItems =
    arm === "vanilla"
      ? workspaceItems.filter(({ name }) => name === "@threenative/playtest")
      : workspaceItems;
  const workspaceNames = arm === "vanilla" ? [] : selectedWorkspaceItems.map(({ name }) => name);
  const workspaceKeys = workspaceNames.map(packageKey);
  const tarballs: Partial<Record<PackageTarball, string>> = {};
  const requiredPackages: readonly PackageTarball[] =
    arm === "vanilla" ? [packageKey("@threenative/playtest")] : [...workspaceKeys, CLI_PACKAGE];
  if (prepare) {
    run("pnpm", ["--filter", "./packages/**", "--if-present", "run", "build"], repo);
    for (const item of selectedWorkspaceItems) {
      run(
        "pnpm",
        [
          "--filter",
          `./${path.relative(repo, item.directory).replaceAll(path.sep, "/")}`,
          "pack",
          "--pack-destination",
          staging,
        ],
        repo,
      );
    }
    if (arm !== "vanilla")
      run(
        "pnpm",
        [
          "--filter",
          `./${sandboxPackageDirectory(CLI_PACKAGE, repo)}`,
          "pack",
          "--pack-destination",
          staging,
        ],
        repo,
      );
    const archivePrefixes = [
      ...selectedWorkspaceItems.map(({ name }) => name),
      ...(arm === "vanilla" ? [] : [CLI_PACKAGE]),
    ].map((name) => ({
      key: packageKey(name),
      name,
      prefix: packageArchivePrefix(name),
    }));
    for (const file of fs.readdirSync(staging)) {
      const owner = archivePrefixes.find(({ prefix }) => file.startsWith(prefix));
      if (owner !== undefined) {
        const tarball = path.join(staging, file);
        assertPackedManifestResolved(tarball);
        assertPackedTypesShipped(tarball);
        tarballs[owner.key] = stampTarball(tarball);
      }
    }
  } else {
    for (const name of requiredPackages) {
      const source = options.packageTarballs?.[name] ?? path.join(staging, `${name}.tgz`);
      tarballs[name] = source.startsWith("file:") ? source : path.resolve(source);
    }
  }

  const missing = requiredPackages.filter((name) => tarballs[name] === undefined);
  if (missing.length > 0)
    throw new Error(`pnpm pack produced no tarball for: ${missing.join(", ")}`);
  if (arm !== "vanilla") assertTemplateSourcesCovered(repo, template, tarballs);

  const scaffold = [
    "node",
    path.join(repo, "packages/create-threenative/dist/index.js"),
    "<target>",
    "--template",
    template,
    ...workspaceNames.flatMap((name) => [
      workspacePackageSourceFlag(name),
      tarballs[packageKey(name)] as string,
    ]),
    workspacePackageSourceFlag(CLI_PACKAGE),
    tarballs[CLI_PACKAGE] as string,
  ];

  // --bare leaves the scaffolding to the agent, so the run starts the way a user's does.
  const bare = options.bare ?? false;
  const install = options.install ?? true;
  // The sandbox root holds the sealed inputs and nothing else; every game lives one folder deep,
  // so a second sweep is another folder rather than a collision with the first one's files.
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(input.brief, path.join(out, "brief.md"));
  fs.copyFileSync(input.reference, path.join(out, "reference.png"));
  let next: string;
  let scaffolded: boolean;
  if (arm === "vanilla") {
    fs.mkdirSync(project, { recursive: true });
    writeVanillaScaffold(project, tarballs[packageKey("@threenative/playtest")] as string);
    if (install && !bare)
      run("pnpm", ["install", "--store-dir", path.join(out, ".pnpm-store")], project);
    next = bare ? `cd ${project} && pnpm install && pnpm dev` : `cd ${project} && pnpm dev`;
    scaffolded = true;
  } else if (bare) {
    // The scaffold invocation is 400 characters of tarball paths. Nobody types that.
    const target = `"\${1:-${name}}"`;
    const script = path.join(out, "scaffold.sh");
    fs.writeFileSync(
      script,
      [
        "#!/bin/sh",
        "set -e",
        scaffold.join(" ").replace("<target>", target),
        `cp brief.md ${target}/brief.md`,
        `cp reference.png ${target}/reference.png`,
        `cp sweep.json ${target}/sweep.json`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(script, 0o755);
    next = `./scaffold.sh ${name}`;
    scaffolded = false;
  } else {
    const scaffoldArgs = [...scaffold.slice(1, 2), project, ...scaffold.slice(3)];
    if (!install) scaffoldArgs.push("--no-install");
    run(scaffold[0] as string, scaffoldArgs, repo);
    next = `cd ${project} && pnpm dev`;
    scaffolded = true;
  }
  if (scaffolded) {
    fs.copyFileSync(input.brief, path.join(project, "brief.md"));
    fs.copyFileSync(input.reference, path.join(project, "reference.png"));
  }

  const leaked = sourceLines(scaffolded ? project : out);
  const manifest: SweepManifest = {
    arm,
    genre,
    briefHash: input.briefHash,
    proofHash: input.proofHash,
    template,
    date: new Date().toISOString(),
    frameworkVersion: frameworkVersion(repo),
    sourceLines: leaked,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(out, "sweep.json"), manifestText);
  // sweep:archive resolves the game folder by looking for src/ beside a sweep.json, so a scaffolded
  // project needs its own copy. The bare arm's scaffold.sh copies this same file at scaffold time.
  if (scaffolded) fs.writeFileSync(path.join(project, "sweep.json"), manifestText);
  process.stdout.write(
    [
      "",
      `${bare ? "bare sandbox ready" : "sandbox ready"} (${arm} arm): ${out}`,
      `  game folder: ${project}${scaffolded ? "" : " (created by ./scaffold.sh)"}`,
      "",
      leaked === 0
        ? "  framework source readable: 0 lines — dist is types plus bundled js"
        : `  framework source readable: ${leaked} lines, via .js.map sourcesContent (a real
    install leaks the same; set sourcemap: false in the tsup configs to close it)`,
      "  CHARTER.md, docs/, PRDs, budgets, LOC classifier: not present",
      `  AGENTS.md in scope: ${bare ? "0 until it scaffolds" : "1 (the generated one)"}`,
      ...(arm === "vanilla"
        ? [
            "  native runtime: not included in the vanilla observation arm",
            "  capability server: not included in the vanilla observation arm",
          ]
        : [
            "  native runtime: packed locally for build --target desktop",
            "  capability server: packed locally for engine_search_capabilities",
          ]),
      `  sealed proof SHA-256: ${input.proofHash}`,
      "",
      `  run from ${out}:`,
      `  ${next}`,
      "",
      "Rebuild it after any framework change — the tarballs are a snapshot, not a link.",
      "",
    ].join("\n"),
  );
  return { manifest, out, project };
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: pnpm sandbox --genre <genre> [options]",
        "",
        "Options:",
        "  --arm <framework|vanilla>  Choose the installed framework or control arm (default: framework).",
        "  --bare                    Write scaffold.sh instead of running the scaffold.",
        "  --genre <genre>           Use the sealed benchmark genre inputs.",
        "  --name <slug>             Name the one game folder inside the sandbox.",
        "  --out <directory>         Sandbox destination (default: ../sandbox).",
        "  --template <template>     Scaffold template (default: starter).",
        "  --help, -h                Show this help.",
        "",
      ].join("\n"),
    );
    return;
  }
  const genre = readFlag("--genre");
  if (genre === undefined) throw new Error("Missing --genre. Use pnpm sandbox --genre <genre>.");
  makeSandbox({
    arm: readFlag("--arm", "framework") as SandboxArm,
    bare: process.argv.includes("--bare"),
    genre,
    name: readFlag("--name"),
    out: readFlag("--out", "../sandbox"),
    template: readFlag("--template", "starter"),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
