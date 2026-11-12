import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { satisfiesSpecifier, templateSpecifier } from "./version-range.js";
import { workspacePackages } from "./workspace-packages.js";

type IManifest = {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
};

const TEMPLATE_ROOT = path.join("packages", "create-threenative", "templates");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

async function readManifest(file: string): Promise<IManifest> {
  return JSON.parse(await readFile(file, "utf8")) as IManifest;
}

function dependencyEntries(manifest: IManifest): readonly (readonly [string, unknown])[] {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.entries(manifest[field] ?? {}));
}

async function templateManifests(root: string): Promise<
  readonly {
    readonly manifest: IManifest;
    readonly name: string;
  }[]
> {
  const directory = path.join(root, TEMPLATE_ROOT);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const manifests: { manifest: IManifest; name: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, "package.json");
    if (!existsSync(file)) {
      manifests.push({ manifest: {}, name: entry.name });
      continue;
    }
    manifests.push({ manifest: await readManifest(file), name: entry.name });
  }
  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

function workspaceVersions(root: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const packageRecord of workspacePackages(path.join(root, "packages"))) {
    if (packageRecord.version !== undefined)
      versions.set(packageRecord.name, packageRecord.version);
  }
  return versions;
}

function checkRuntimeVersionSource(root: string, versions: ReadonlyMap<string, string>): string[] {
  const runtimeName = "@threenative/runtime-native";
  const runtimeVersion = versions.get(runtimeName);
  if (runtimeVersion === undefined) {
    return [`workspace package ${runtimeName} has no version to cross-check`];
  }
  const cmakePath = path.join(root, "packages", "runtime-native", "CMakeLists.txt");
  if (!existsSync(cmakePath)) return [];
  const source = requireReadFile(cmakePath);
  const findings: string[] = [];
  if (
    !/string\(JSON\s+MYSTRAL_PACKAGE_VERSION\s+GET\s+"\$\{MYSTRAL_PACKAGE_JSON\}"\s+version\)/u.test(
      source,
    )
  ) {
    findings.push(
      `runtime-native CMakeLists.txt does not read the version from packages/runtime-native/package.json (${runtimeVersion})`,
    );
  }
  if (/project\([^)]*\bVERSION\s+\d+\.\d+\.\d+/u.test(source)) {
    findings.push(
      "runtime-native CMakeLists.txt contains a second literal project version; keep package.json as the single source",
    );
  }
  return findings;
}

function requireReadFile(file: string): string {
  // This checker only reaches this helper after existsSync; keeping the read synchronous makes
  // the CMake cross-check independent of the template scan's async order.
  return readFileSync(file, "utf8");
}

/** Return actionable pin findings; an empty array is a passing gate. */
export async function checkVersionPins(root = process.cwd()): Promise<readonly string[]> {
  const versions = workspaceVersions(root);
  const templates = await templateManifests(root);
  const findings: string[] = [];
  const thirdParty = new Map<string, { name: string; value: string }>();

  for (const template of templates) {
    for (const [dependency, value] of dependencyEntries(template.manifest)) {
      if (typeof value !== "string") {
        findings.push(`template ${template.name} has a non-string pin for ${dependency}`);
        continue;
      }
      const expected = versions.get(dependency);
      if (expected !== undefined) {
        const specifier = templateSpecifier(dependency, expected);
        if (!satisfiesSpecifier(expected, value)) {
          findings.push(
            `template ${template.name} pins ${dependency} at ${value}; expected workspace version ${expected} as ${specifier}`,
          );
        }
        continue;
      }
      if (dependency.startsWith("@threenative/")) {
        findings.push(
          `template ${template.name} references unknown internal package ${dependency}; expected a workspace package version`,
        );
        continue;
      }
      const previous = thirdParty.get(dependency);
      if (previous === undefined) {
        thirdParty.set(dependency, { name: template.name, value });
      } else if (previous.value !== value) {
        findings.push(
          `third-party dependency ${dependency} is ${previous.value} in template ${previous.name} but ${value} in template ${template.name}`,
        );
      }
    }
  }

  findings.push(...checkRuntimeVersionSource(root, versions));
  return findings;
}

async function main(): Promise<void> {
  const findings = await checkVersionPins();
  if (findings.length > 0) {
    console.error(
      `TN_VERSION_PINS_DRIFTED:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `version pins ok: ${workspaceVersions(process.cwd()).size} workspace package versions cross-checked`,
  );
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
