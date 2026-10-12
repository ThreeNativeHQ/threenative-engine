import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceToken = /src\/[A-Za-z0-9_./-]+\.cpp/gu;
const explicitlyExcludedSources = new Set([
  "src/gltf/gltf_loader.cpp",
  "src/utils/cgltf_impl.cpp",
]);

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function stripCmakeComments(cmakeSource) {
  const withoutBracketComments = cmakeSource.replace(
    /#\[(=*)\[[\s\S]*?\]\1\]/gu,
    (comment) => comment.replace(/[^\r\n]/gu, " "),
  );
  return withoutBracketComments.replace(/#[^\r\n]*/gu, "");
}

function sourcePathsOnDisk(directory, root = directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...sourcePathsOnDisk(path, root));
    } else if (entry.isFile() && entry.name.endsWith(".cpp")) {
      paths.push(`src/${normalizePath(relative(root, path))}`);
    }
  }
  return paths;
}

function excludedSourcePaths(cmakeSource) {
  const block = /set\s*\(\s*MYSTRAL_EXCLUDED_CPP_SOURCES([\s\S]*?)\)/u.exec(cmakeSource);
  return new Set([
    ...explicitlyExcludedSources,
    ...(block?.[1]?.match(sourceToken) ?? []),
  ]);
}

export function checkSourceList({ cmakeSource, sourceRoot, sourcePaths } = {}) {
  if (typeof cmakeSource !== "string")
    throw new TypeError("checkSourceList requires the CMake source text");

  const activeCmakeSource = stripCmakeComments(cmakeSource);
  const excluded = excludedSourcePaths(activeCmakeSource);
  const listed = new Set(activeCmakeSource.match(sourceToken) ?? []);
  for (const path of excluded) listed.delete(path);

  const hasExplicitSourcePaths = Array.isArray(sourcePaths);
  const actualSources = (hasExplicitSourcePaths
    ? sourcePaths
    : sourcePathsOnDisk(resolve(sourceRoot ?? "src")))
    .map(normalizePath)
    .sort();
  const unlisted = actualSources.filter((path) => !listed.has(path) && !excluded.has(path));
  const missing = hasExplicitSourcePaths
    ? []
    : [...listed].filter((path) => !existsSync(join(resolve(sourceRoot ?? "src"), path.slice(4))));
  return { unlisted, missing, excluded: [...excluded].sort() };
}

/** CMakeLists.txt plus the modules it includes (cmake/NativeEngine.cmake lists engine sources). */
export function readCmakeSource(packageRoot) {
  const cmakeModules = join(packageRoot, "cmake");
  const modules = readdirSync(cmakeModules)
    .filter((name) => name.endsWith(".cmake"))
    .sort()
    .map((name) => readFileSync(join(cmakeModules, name), "utf8"));
  return [readFileSync(join(packageRoot, "CMakeLists.txt"), "utf8"), ...modules].join("\n");
}

function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptDirectory, "..");
  const sourceRoot = join(packageRoot, "src");
  const report = checkSourceList({ cmakeSource: readCmakeSource(packageRoot), sourceRoot });
  if (report.unlisted.length > 0 || report.missing.length > 0) {
    if (report.unlisted.length > 0)
      console.error(`Unlisted native C++ sources: ${report.unlisted.join(", ")}`);
    if (report.missing.length > 0)
      console.error(`Missing CMake native C++ sources: ${report.missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `native source list passed (${report.excluded.length} explicit exclusions)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
