import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateOptimizationProvenance } from "../packages/runtime-native/scripts/measure-android-js-engine.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Bound to the exact CMake-generated runtime link/object edges; unknown Ninja
// expressions fail closed rather than certifying another target's optimization.
export function runtimeOptimizationProof(ninja, rules, library, buildDirectory) {
  const reject = () => ({ optimization: "other", objects: [] });
  const edges = [
    ...`${ninja}\n`.matchAll(/^build ([^\n]+): ([^ \n]+) ([^\n]*)\n((?: {2}[^\n]*\n)*)/gmu),
  ].map((match) => ({
    outputs: match[1].split(/\s+/u),
    rule: match[2],
    inputs: match[3].split(/\s+\|/u)[0].trim().split(/\s+/u),
    body: match[4],
  }));
  const sameOutput = (output) =>
    !output.includes("$") && path.resolve(buildDirectory, output) === path.resolve(library);
  const links = edges.filter(
    (edge) =>
      /^CXX_SHARED_LIBRARY_LINKER__mystral-runtime(?:_|$)/u.test(edge.rule) &&
      edge.outputs.some(sameOutput),
  );
  if (
    links.length !== 1 ||
    !links[0].inputs.length ||
    links[0].inputs.some((input) => !input.endsWith(".o") || input.includes("$"))
  )
    return reject();
  const compilerRules = [...`${rules}\n`.matchAll(/^rule ([^\n]+)\n((?: {2}[^\n]*\n)*)/gmu)];
  const objects = [];
  for (const input of links[0].inputs) {
    const compile = edges.filter(
      (edge) =>
        edge.outputs.length === 1 &&
        edge.outputs[0] === input &&
        /^(?:C|CXX)_COMPILER__mystral-runtime(?:_|$)/u.test(edge.rule),
    );
    if (compile.length !== 1) return reject();
    const flags = [...compile[0].body.matchAll(/^ {2}FLAGS = ([^\n]*)$/gmu)];
    const rule = compilerRules.filter((match) => match[1] === compile[0].rule);
    // Only the plain compiler argument shape is proven here. Shell quoting,
    // escaping and response files can conceal a later optimization override.
    const unknownArgumentSyntax = /['"\\`@;&|<>(){}\[\]*?#]/u;
    if (
      flags.length !== 1 ||
      flags[0][1].includes("$") ||
      unknownArgumentSyntax.test(flags[0][1]) ||
      rule.length !== 1
    )
      return reject();
    const commands = [...rule[0][2].matchAll(/^ {2}command = ([^\n]+)$/gmu)];
    if (commands.length !== 1) return reject();
    const command = commands[0][1];
    const variables = [...command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
      (match) => match[1],
    );
    if (
      command.split("$FLAGS").length !== 2 ||
      unknownArgumentSyntax.test(command) ||
      /(?:^|\s)-O\S*/u.test(command) ||
      command.includes("${") ||
      variables.some(
        (name) => !["DEFINES", "INCLUDES", "FLAGS", "in", "out", "DEP_FILE"].includes(name),
      ) ||
      ["$DEFINES", "$INCLUDES"].some((name) => command.indexOf(name) > command.indexOf("$FLAGS"))
    )
      return reject();
    const optimizationOptions = flags[0][1].split(/\s+/u).filter((token) => token.startsWith("-O"));
    const effectiveOptimization = optimizationOptions.at(-1);
    objects.push({ output: input, optimizationOptions, effectiveOptimization });
    if (effectiveOptimization !== "-O2") return { optimization: "other", objects };
  }
  return { optimization: "-O2", objects };
}

// APK packaging may strip symbols. Prove the configured NDK transformation produces the
// exact executed APK bytes; a matching filename, build ID or unstripped digest is insufficient.
export function inspectAndroidBuildProvenance(
  abi,
  packagedSha256,
  root,
  execute = execFileSync,
  report = () => {},
) {
  const diagnostic = (reason, fields = {}) => report({ abi, packagedSha256, reason, ...fields });
  const build = path.join(root, "android/app/build/intermediates");
  const merged = [
    path.join(build, "merged_native_libs/debug/out/lib", abi, "libmystral-runtime.so"),
    path.join(
      build,
      "merged_native_libs/debug/mergeDebugNativeLibs/out/lib",
      abi,
      "libmystral-runtime.so",
    ),
  ]
    .filter(existsSync)
    .map((file) => hash(readFileSync(file)));
  diagnostic("merged-inputs", { mergedSha256: merged });
  const cxx = path.join(build, "cxx/Debug");
  if (!existsSync(cxx)) diagnostic("cxx-directory-missing", { cxx });
  const candidates = [];
  if (existsSync(cxx))
    for (const entry of readdirSync(cxx, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nativeLibrary = path.join(cxx, entry.name, "obj", abi, "libmystral-runtime.so");
      const buildNinja = path.join(root, "android/app/.cxx/Debug", entry.name, abi, "build.ninja");
      const cacheFile = path.join(path.dirname(buildNinja), "CMakeCache.txt");
      const missing = [nativeLibrary, buildNinja, cacheFile].filter((file) => !existsSync(file));
      if (missing.length) {
        diagnostic("compiler-input-missing", { nativeLibrary, buildNinja, cacheFile, missing });
        continue;
      }
      const rawHash = hash(readFileSync(nativeLibrary));
      diagnostic("compiler-input", { nativeLibrary, buildNinja, cacheFile, rawSha256: rawHash });
      if (!merged.includes(rawHash)) {
        diagnostic("raw-merged-mismatch", { rawSha256: rawHash });
        continue;
      }
      let packagedHash = rawHash;
      if (rawHash !== packagedSha256) {
        const cache = readFileSync(cacheFile, "utf8");
        const strip = /^CMAKE_STRIP:[^=\n]+=([^\r\n]+)$/mu.exec(cache)?.[1];
        const cachedCompiler = /^CMAKE_CXX_COMPILER:[^=\n]+=([^\r\n]+)$/mu.exec(cache)?.[1];
        // NDK r28c defines the compiler as a normal CMake variable, so CMake 3.22.1
        // records it in generated compiler metadata without necessarily caching it.
        const compilerMetadata = path.join(path.dirname(buildNinja), "CMakeFiles");
        const compilerMetadataDirectories = existsSync(compilerMetadata)
          ? readdirSync(compilerMetadata, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => ({
                name: entry.name,
                supportedVersion: /^\d+\.\d+(?:\.\d+)?(?:-g[a-f0-9]+(?:-dirty)?)?$/u.test(
                  entry.name,
                ),
                compilerRecordExists: existsSync(
                  path.join(compilerMetadata, entry.name, "CMakeCXXCompiler.cmake"),
                ),
              }))
          : [];
        const generatedCompilers = compilerMetadataDirectories
          .filter((entry) => entry.supportedVersion)
          .map((entry) => path.join(compilerMetadata, entry.name, "CMakeCXXCompiler.cmake"))
          .filter(existsSync)
          .map((file) => {
            const declarations = [
              ...readFileSync(file, "utf8").matchAll(
                /^set\(CMAKE_CXX_COMPILER "([^"\r\n]+)"\)$/gmu,
              ),
            ];
            return { file, compiler: declarations.length === 1 ? declarations[0][1] : undefined };
          });
        const compilerPaths = [
          cachedCompiler,
          ...generatedCompilers.map((row) => row.compiler),
        ].filter(Boolean);
        const compiler = compilerPaths[0];
        const compilerMetadataValid =
          compilerMetadataDirectories.every(
            (entry) => !entry.compilerRecordExists || entry.supportedVersion,
          ) &&
          generatedCompilers.every((row) => row.compiler) &&
          new Set(compilerPaths).size === 1;
        diagnostic("configured-compiler", {
          cachedCompiler,
          generatedCompilers,
          compilerMetadataDirectories,
          compilerMetadataValid,
        });
        const ndkRoots = [
          ...cache.matchAll(/^(?:CMAKE_ANDROID_NDK|ANDROID_NDK):[^=\n]+=([^\r\n]+)$/gmu),
        ].map((match) => path.resolve(match[1]));
        const ndk = ndkRoots[0];
        if (
          !strip ||
          !compiler ||
          !compilerMetadataValid ||
          !ndk ||
          new Set(ndkRoots).size !== 1 ||
          !path.isAbsolute(strip) ||
          path.basename(strip) !== "llvm-strip" ||
          !/^clang\+\+(?:-\d+)?$/u.test(path.basename(compiler)) ||
          path.dirname(strip) !== path.dirname(compiler) ||
          ![strip, compiler].every(existsSync) ||
          !/^toolchains\/llvm\/prebuilt\/[^/]+\/bin$/u.test(path.relative(ndk, path.dirname(strip)))
        ) {
          diagnostic("configured-toolchain-rejected", { strip, compiler, ndkRoots });
          continue;
        }
        const temporary = mkdtempSync(path.join(tmpdir(), "tn-ci-strip-proof-"));
        try {
          const output = path.join(temporary, "libmystral-runtime.so");
          execute(strip, ["--strip-unneeded", "-o", output, nativeLibrary], {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          });
          packagedHash = hash(readFileSync(output));
          diagnostic("strip-result", {
            strip,
            nativeLibrary,
            transformedSha256: packagedHash,
            matchesApk: packagedHash === packagedSha256,
          });
        } finally {
          rmSync(temporary, { recursive: true, force: true });
        }
      }
      const rulesFile = path.join(path.dirname(buildNinja), "CMakeFiles/rules.ninja");
      const optimization = runtimeOptimizationProof(
        readFileSync(buildNinja, "utf8"),
        existsSync(rulesFile) ? readFileSync(rulesFile, "utf8") : "",
        nativeLibrary,
        path.dirname(buildNinja),
      );
      diagnostic("runtime-optimization", { nativeLibrary, rulesFile, ...optimization });
      candidates.push({
        nativeLibrary,
        buildNinja,
        sha256: packagedHash,
        optimization: optimization.optimization,
      });
    }
  diagnostic("candidate-summary", { candidates });
  return validateOptimizationProvenance(packagedSha256, candidates);
}
