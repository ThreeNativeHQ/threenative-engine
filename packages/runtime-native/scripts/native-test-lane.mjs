import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeRoot = join(fileURLToPath(new URL("..", import.meta.url)));

export function desktopPreset() {
  if (process.platform === "darwin") return "tn-macos";
  if (process.platform === "win32") return "tn-windows";
  return "tn-linux";
}

export function desktopBuildDirectory(suffix = "") {
  const name = suffix === "" ? desktopPreset() : `${desktopPreset()}-${suffix}`;
  return join(runtimeRoot, "build", name);
}

export function resolveCmake() {
  const windows = process.platform === "win32";
  const venvCmake = join(
    runtimeRoot,
    ".runtime",
    "tools-venv",
    windows ? "Scripts" : "bin",
    windows ? "cmake.exe" : "cmake",
  );
  const cmake =
    spawnSync("cmake", ["--version"], { stdio: "ignore" }).status === 0 ? "cmake" : venvCmake;
  if (cmake === venvCmake && !existsSync(venvCmake)) {
    throw new Error("cmake was not found on PATH or in .runtime/tools-venv; run pnpm native:build");
  }
  return cmake;
}

/**
 * Windows installs npm-published CLIs as `.cmd` shims, and `spawnSync` does not apply PATHEXT the
 * way a shell does — so `pnpm` is ENOENT on a Windows runner while `pnpm.cmd` runs fine. That is
 * what stopped the Windows desktop leg once its earlier failure was cleared.
 *
 * Retry on ENOENT rather than appending `.cmd` up front: `node` and `cmake` are real executables
 * whose `.cmd` does not exist, so a blanket rewrite would break the commands that already work.
 */
/**
 * Quote one argument for `cmd.exe`, which is what `shell: true` runs on Windows.
 *
 * Only what needs quoting is quoted, so an unquoted command line still reads the way it did
 * before this existed. A path with a space in it — `C:\\Program Files\\…` — is the case that
 * silently splits into two arguments otherwise.
 */
export function quoteForWindowsShell(argument) {
  if (argument.length > 0 && !/[\s"^&|<>()]/u.test(argument)) return argument;
  return `"${argument.replace(/"/gu, '\\"')}"`;
}

export function retryAsWindowsShim(command, platform = process.platform) {
  if (platform !== "win32") return undefined;
  if (/[\\/]/u.test(command) || /\.[a-z0-9]+$/iu.test(command)) return undefined;
  return `${command}.cmd`;
}

export function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? runtimeRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  };
  let result = spawnSync(command, args, spawnOptions);
  if (result.error?.code === "ENOENT" || result.error?.code === "EINVAL") {
    const shim = retryAsWindowsShim(command);
    if (shim !== undefined) {
      // Node has refused to spawn a `.cmd` without a shell since the 2024 command-injection fix,
      // and reports that refusal as EINVAL. So the shim needs `shell: true` — and under a shell
      // the arguments are joined into one command line, which means anything carrying a space has
      // to be quoted or it arrives as two arguments.
      result = spawnSync(shim, args.map(quoteForWindowsShell), {
        ...spawnOptions,
        shell: true,
      });
    }
  }
  if (result.error) throw result.error;
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}:\n${log}`);
  return log;
}

export function buildNativeTarget(cmake, buildDirectory, target, timeout = 1_800_000) {
  const requested = process.env.CMAKE_BUILD_PARALLEL_LEVEL;
  if (requested !== undefined &&
      (!/^[1-9]\d*$/u.test(requested) || !Number.isSafeInteger(Number(requested)))) {
    throw new Error("CMAKE_BUILD_PARALLEL_LEVEL must be a positive integer");
  }
  const parallel = requested === undefined ? ["--parallel"] : ["--parallel", requested];
  return run(cmake, ["--build", buildDirectory, "--target", target, ...parallel], { timeout });
}

export function nativeTestExecutable(buildDirectory, target) {
  return join(buildDirectory, process.platform === "win32" ? `${target}.exe` : target);
}

/**
 * Package resolution the shipping build already did, carried into a verification build.
 *
 * These builds reuse the shipping build's compilers because a fresh configure cannot rediscover
 * them. The same turns out to be true of anything a toolchain resolved: on Windows the shipping
 * build finds CURL through vcpkg, and a verification configure that did not carry that forward
 * died on "Could NOT find CURL" for a library that is installed and had already been located once.
 *
 * Only entries the shipping cache actually resolved are forwarded. A `-NOTFOUND` value is a
 * record that the search failed, and passing it on would pin the failure instead of retrying it.
 */
export function inheritedCacheArguments(cache) {
  const inherited = [
    "CMAKE_TOOLCHAIN_FILE",
    "CMAKE_PREFIX_PATH",
    "VCPKG_TARGET_TRIPLET",
    "CURL_LIBRARY",
    "CURL_INCLUDE_DIR",
  ];
  const args = [];
  for (const name of inherited) {
    const value = new RegExp(`^${name}:[^=]*=(.*)$`, "mu").exec(cache)?.[1];
    if (value === undefined || value === "" || value.endsWith("-NOTFOUND")) continue;
    args.push(`-D${name}=${value}`);
  }
  return args;
}

function configureVerificationBuild(cmake, suffix, cacheVariables) {
  const buildDirectory = desktopBuildDirectory(suffix);
  const shippingCache = join(desktopBuildDirectory(), "CMakeCache.txt");
  if (!existsSync(shippingCache)) {
    throw new Error(`${shippingCache} does not exist; run pnpm native:build`);
  }
  const cache = readFileSync(shippingCache, "utf8");
  const cached = (name) => {
    const match = cache.match(new RegExp(`^${name}:[^=]*=(.*)$`, "mu"));
    if (match?.[1] === undefined || match[1] === "") {
      throw new Error(`${name} is not set in ${shippingCache}; run pnpm native:build`);
    }
    return match[1];
  };
  const windows = process.platform === "win32";
  const localNinja = join(
    runtimeRoot,
    ".runtime",
    "tools-venv",
    windows ? "Scripts" : "bin",
    windows ? "ninja.exe" : "ninja",
  );
  const ninja = existsSync(localNinja) ? localNinja : cached("CMAKE_MAKE_PROGRAM");
  run(
    cmake,
    [
      "--preset",
      desktopPreset(),
      "-B",
      buildDirectory,
      `-DCMAKE_MAKE_PROGRAM=${ninja}`,
      `-DCMAKE_C_COMPILER=${cached("CMAKE_C_COMPILER")}`,
      `-DCMAKE_CXX_COMPILER=${cached("CMAKE_CXX_COMPILER")}`,
      ...inheritedCacheArguments(cache),
      ...cacheVariables.map(([name, value]) => `-D${name}=${value}`),
    ],
    { timeout: 900_000 },
  );
  return buildDirectory;
}

export function configureVideoVerificationBuild(cmake) {
  return configureVerificationBuild(cmake, "contracts-video", [["TN_ENABLE_VIDEO", "ON"]]);
}

/**
 * TN_ENABLE_METAHUMAN needs the pinned OpenRigLogic source, which the default desktop set
 * never fetches, so the optional dependency is acquired here rather than on every build.
 */
/**
 * TN_ENABLE_METAHUMAN needs the pinned OpenRigLogic source, which the default desktop set never
 * fetches, so the optional dependency is acquired here rather than on every build.
 */
function configureMetaHumanBuild(cmake, suffix, cacheVariables) {
  run(process.execPath, [join(runtimeRoot, "scripts", "download-deps.mjs"), "--only", "openriglogic"], {
    timeout: 1_800_000,
  });
  return configureVerificationBuild(cmake, suffix, cacheVariables);
}

export function configureMetaHumanVerificationBuild(cmake) {
  return configureMetaHumanBuild(cmake, "contracts-metahuman", [["TN_ENABLE_METAHUMAN", "ON"]]);
}

/**
 * The same rig contract under AddressSanitizer and UBSan, in its own build directory.
 *
 * The parser reads untrusted bytes into a C++ rig, so a leak or a bad free shows up only with the
 * allocator instrumented; a build directory of its own keeps the plain contract proof on the plain
 * toolchain flags.
 */
export function configureMetaHumanSanitizerVerificationBuild(cmake) {
  return configureMetaHumanBuild(cmake, "asan-metahuman", [
    ["TN_ENABLE_METAHUMAN", "ON"],
    ["TN_ENABLE_SANITIZERS", "ON"],
  ]);
}

export function configurePhysicsVerificationBuild(cmake) {
  run(process.execPath, [join(runtimeRoot, "scripts", "build-native-physics.mjs"), "--desktop"], {
    timeout: 1_800_000,
  });
  const rustVersion = run("rustc", ["-vV"]);
  const host = /^host:\s*(\S+)$/mu.exec(rustVersion)?.[1];
  if (!host) throw new Error("rustc -vV did not report a host target for desktop physics");
  const libraryName =
    process.platform === "win32"
      ? "threenative_native_physics.lib"
      : "libthreenative_native_physics.a";
  const library = join(runtimeRoot, ".runtime", "physics-target", host, "release", libraryName);
  if (!existsSync(library)) {
    throw new Error(`desktop native physics build did not produce ${library}`);
  }
  return configureVerificationBuild(cmake, "contracts-physics", [
    ["THREENATIVE_PHYSICS_LIBRARY", library],
    ["TN_ENABLE_NATIVE_PHYSICS", "ON"],
  ]);
}
