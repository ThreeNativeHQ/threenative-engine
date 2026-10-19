import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createProject, discoverTemplateNames } from "../src/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

interface IManifestEntry {
  readonly importPath: string;
  readonly requires?: readonly string[];
  readonly symbol: string;
}

const manifestEntries = (
  JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/create-threenative/capabilities.json"), "utf8"),
  ) as { entries: IManifestEntry[] }
).entries.filter(
  (entry) =>
    !entry.importPath.startsWith("src/") && !entry.importPath.startsWith("@threenative/template/"),
);

const packageOf = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

// The workspace links every package into every other one, so a resolve from the repository
// passes on all of them. Only the declared closure is linked into the scaffolded project.
const workspacePackages = new Map(
  readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REPO_ROOT, "packages", entry.name))
    .flatMap((directory) => {
      try {
        const { name } = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        return [[name as string, directory] as const];
      } catch {
        return [];
      }
    }),
);
const corePackages = path.join(REPO_ROOT, "packages/core/node_modules");

function installedDirectory(name: string): string | undefined {
  const workspace = workspacePackages.get(name);
  if (workspace !== undefined) return workspace;
  const installed = path.join(corePackages, name);
  return existsSync(installed) ? realpathSync(installed) : undefined;
}

async function unresolvable(project: string, specifiers: readonly string[]): Promise<string[]> {
  const probe = `const failed = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
  try { import.meta.resolve(specifier); } catch { failed.push(specifier); }
}
process.stdout.write(JSON.stringify(failed));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: project,
  });
  return JSON.parse(stdout) as string[];
}

describe("scaffolded game manifest imports", () => {
  it("resolves every manifest import in every template, or the entry names its install", async () => {
    const templates = discoverTemplateNames();
    expect(templates.length).toBeGreaterThan(0);
    const root = await makeTempDir("threenative-manifest-imports-");
    try {
      for (const template of templates) {
        const { target } = await createProject(
          { install: false, target: template, template },
          root,
        );
        const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
        const declared = Object.keys({ ...generated.dependencies, ...generated.devDependencies });
        for (const name of declared) {
          const source = installedDirectory(name);
          if (source === undefined) continue;
          const link = path.join(target, "node_modules", name);
          await mkdir(path.dirname(link), { recursive: true });
          await symlink(source, link, "dir");
        }

        const specifiers = [...new Set(manifestEntries.map((entry) => entry.importPath))];
        const failed = new Set(await unresolvable(target, specifiers));
        const undocumented = manifestEntries
          .filter((entry) => failed.has(entry.importPath) && (entry.requires ?? []).length === 0)
          .map((entry) => `${entry.symbol} -> ${entry.importPath}`);
        expect(undocumented, template).toEqual([]);

        // Control: the resolver is not trivially passing. A package the template does not
        // declare stays unresolvable, which is exactly why its entries carry an install line.
        const undeclared = specifiers.filter(
          (specifier) => !declared.includes(packageOf(specifier)),
        );
        expect(undeclared.length, template).toBeGreaterThan(0);
        expect(
          undeclared.filter((specifier) => !failed.has(specifier)),
          template,
        ).toEqual([]);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);
});
