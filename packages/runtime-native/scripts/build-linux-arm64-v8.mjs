import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native Ubuntu noble arm64 packages; producer installs these exact versions before invoking us.
export const LINUX_ARM64_V8_BUILD = Object.freeze({
  recipe: 2,
  version: "13.1.201.22",
  source: "9c09e7876ff830e1f9a731aa930040d1028ff5a1",
  depotTools: "08f3e8c0eb66d6de3a048a757d0ff708dbc8ea34",
  gn: "95b0f8fe31a992a33c040bbe3867901335c12762",
  gnPackage: "gn/gn/linux-arm64",
  gnSha256: "31739b62d88843b32726c4ace0c93b36b65efbcba89bb033891d454766d9e689",
  toolchain: Object.freeze({
    base: "/usr/lib/llvm-18",
    version: "18.1.3",
    packageVersion: "1:18.1.3-1ubuntu1",
    architecture: "arm64",
    index:
      "https://ports.ubuntu.com/ubuntu-ports/dists/noble-updates/universe/binary-arm64/Packages.xz",
    compilerRt: Object.freeze({
      packageVersion: "1:18.1.3-1",
      index: "https://ports.ubuntu.com/ubuntu-ports/dists/noble/universe/binary-arm64/Packages.xz",
      archive: "/usr/lib/llvm-18/lib/clang/18/lib/linux/libclang_rt.builtins-aarch64.a",
      objects: 278,
      sha256: "af24a6be2920609e5dea1218caad93a17885497e764cef2dc78512fdec159e98",
    }),
    packages: Object.freeze({
      "libclang-rt-18-dev": "daeaee613fd98916b48201352499b417131c605601d73429c6c71cb4c81ee56d",
      "clang-18": "e3a70e054d3c0d0841cd7d1555deeab82d75609d34438b1cfc1b187b0add7d77",
      "lld-18": "c33a2e048536e6d902a9f209d114d049b5becbedb94d11eb77f313cad95a830c",
      "llvm-18": "1d9c87ff9fe17d0ee00703ec0f339ab687e2807b3508b51cf517e05281de104d",
    }),
  }),
});
const BUILD_REVISION = "61966507f36426729edb3cf308d78b80eecb7b73";
export const CHROMIUM_BUILD_LICENSE = Object.freeze({
  revision: "054463d932e1883832422ab7280c71899cde8ae7",
  url: "https://chromium.googlesource.com/chromium/src/+/054463d932e1883832422ab7280c71899cde8ae7/LICENSE?format=TEXT",
  bytes: 1536,
  sha256: "368cca1106be99d39ecd32a38d8305585d802a475effb66380b91ffc9bcf709b",
});
// Packaging-only repair of attempt 38711129527; all other state fields must match exactly.
const PREVIOUS_BUILD_SCRIPT = "3a5872301fb0fb8b9ed380b1172ca15de414fa370e23812356c736ffc233b1e8";
export function reusableLinuxArm64V8State(previous, expected, repairScriptSha) {
  if (previous === expected) return true;
  const current = JSON.parse(expected);
  return current.buildScript === repairScriptSha && previous === JSON.stringify({
    ...current, buildScript: PREVIOUS_BUILD_SCRIPT,
  });
}
export function fetchChromiumBuildLicense(run = (program, args) => execFileSync(program, args)) {
  const bytes = Buffer.from(run("curl", ["--fail", "--location", "--silent", "--show-error", CHROMIUM_BUILD_LICENSE.url]).toString().trim(), "base64");
  if (bytes.length !== CHROMIUM_BUILD_LICENSE.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== CHROMIUM_BUILD_LICENSE.sha256)
    throw new Error("Pinned Chromium build license checksum mismatch");
  return bytes;
}
const SDK = ".threenative-llvm-18";
const BUILTINS = "lib/clang/18/lib/aarch64-unknown-linux-gnu/libclang_rt.builtins.a";
const packageVersion = (name) => name === "libclang-rt-18-dev"
  ? LINUX_ARM64_V8_BUILD.toolchain.compilerRt.packageVersion
  : LINUX_ARM64_V8_BUILD.toolchain.packageVersion;
const RECEIPT = "build-receipt.json";
const LINUX_PACKAGES = ["libglib2.0-dev", "pkg-config"];
const GLIB_MODULES = ["glib-2.0", "gmodule-2.0", "gobject-2.0", "gthread-2.0"];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// Keep this producer independent: changing Android's script invalidates its expensive cache.
function payloadFiles(root, directory = "") {
  const result = [];
  for (const entry of readdirSync(join(root, directory)).sort()) {
    const relative = directory ? `${directory}/${entry}` : entry;
    if (relative === RECEIPT) continue;
    const stats = lstatSync(join(root, relative));
    if (stats.isDirectory()) result.push(...payloadFiles(root, relative));
    else if (stats.isFile() && stats.size > 0) result.push(relative);
    else throw new Error(`V8 payload has an empty or non-regular file: ${relative}`);
  }
  return result;
}

function checkoutV8Source(directory, url, revision, run) {
  mkdirSync(directory, { recursive: true });
  run("git", ["init"], directory);
  run("git", ["fetch", "--depth=1", url, revision], directory);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], directory);
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory, encoding: "utf8",
  }).trim();
  if (actual !== revision) throw new Error(`V8 source revision mismatch: ${actual} != ${revision}`);
}

export function promoteV8Payload(stage, destination, backup) {
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, backup);
  try {
    renameSync(stage, destination);
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}
const BINARIES = ["clang", "clang++", "ld.lld", "llvm-ar", "llvm-nm"];
const LICENSES = {
  "V8-LICENSE": "LICENSE",
  "V8-LICENSE.v8": "LICENSE.v8",
  "V8-FDLIBM": "LICENSE.fdlibm",
  "V8-STRONGTALK": "LICENSE.strongtalk",
  // Build dependency notice; inclusion does not assert that compiler-rt objects are embedded.
  "COMPILER-RT-COPYRIGHT": "/usr/share/doc/libclang-rt-18-dev/copyright",
};

export function linuxArm64V8GnArgs() {
  return [
    'target_os="linux"',
    'target_cpu="arm64"',
    'v8_target_cpu="arm64"',
    "is_debug=false",
    "is_component_build=false",
    "v8_monolithic=true",
    "v8_enable_i18n_support=false",
    "v8_enable_test_features=false",
    "v8_enable_gdbjit=false",
    "v8_use_external_startup_data=false",
    "v8_enable_pointer_compression=false",
    "v8_enable_sandbox=false",
    "symbol_level=0",
    "strip_debug_info=true",
    "treat_warnings_as_errors=false",
    "use_sysroot=false",
    "use_custom_libcxx=false",
    "use_custom_libcxx_for_host=false",
    "clang_use_chrome_plugins=false",
    "is_clang=true",
    `clang_base_path="//${SDK}"`,
    'clang_version="18"',
    "use_lld=true",
    "use_thin_lto=false",
  ].join(" ");
}

/** Check every archive object, including GNU long-name and BSD extended-name members. */
export function assertArm64V8Archive(bytes) {
  if (bytes.subarray(0, 8).toString() !== "!<arch>\n")
    throw new Error("V8 monolith is not a regular ar archive");
  let offset = 8;
  let objects = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 60);
    const sizeText = header.subarray(48, 58).toString().trim();
    const size = Number(sizeText);
    if (
      header.length !== 60 ||
      header.subarray(58).toString() !== "`\n" ||
      !/^\d+$/u.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      offset + 60 + size > bytes.length
    )
      throw new Error("Malformed V8 ar member");
    let name = header.subarray(0, 16).toString().trim();
    let object = bytes.subarray(offset + 60, offset + 60 + size);
    if (name.startsWith("#1/")) {
      const length = Number(name.slice(3));
      if (!Number.isSafeInteger(length) || length < 1 || length > size)
        throw new Error("Malformed V8 BSD ar name");
      name = object.subarray(0, length).toString().replace(/\0+$/u, "");
      object = object.subarray(length);
    }
    if (!["/", "//", "/SYM64/", "__.SYMDEF", "__.SYMDEF SORTED"].includes(name)) {
      if (
        object.length < 64 ||
        !object.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
        object.readUInt16LE(16) !== 1 ||
        object.readUInt16LE(18) !== 183
      )
        throw new Error(`V8 ar member ${name} is not an aarch64 ELF relocatable object`);
      objects++;
    }
    offset += 60 + size + (size % 2);
  }
  if (!objects || offset !== bytes.length)
    throw new Error("V8 ar archive has no objects or is truncated");
  return objects;
}

function validateLinuxPrerequisites(linux) {
  for (const name of LINUX_PACKAGES) {
    const [actual, version, architecture, status] = (linux?.packages?.[name] ?? "").split("\t");
    if (actual !== name || !/^\d[\w.+:~_-]*$/u.test(version ?? "") ||
      architecture !== "arm64" || status !== "install ok installed")
      throw new Error(`V8 Linux prerequisite requires installed native ${name} with exact version identity`);
  }
  for (const name of GLIB_MODULES) {
    if (!/^\d+\.\d+\.\d+$/u.test(linux?.modules?.[name] ?? ""))
      throw new Error(`V8 Linux prerequisite pkg-config module missing or malformed: ${name}`);
  }
}

export function inspectLinuxArm64V8Toolchain({
  run = (program, args) => execFileSync(program, args, { encoding: "utf8" }),
  hash = sha256,
  read = readFileSync,
} = {}) {
  const pin = LINUX_ARM64_V8_BUILD.toolchain;
  const packages = {};
  for (const name of Object.keys(pin.packages)) {
    const identity = run("dpkg-query", [
      "-W",
      "-f=${Package}\t${Version}\t${Architecture}\t${Status}",
      name,
    ]).trim();
    if (identity !== `${name}\t${packageVersion(name)}\tarm64\tinstall ok installed`)
      throw new Error(`V8 requires native ${name}=${packageVersion(name)}: ${identity}`);
    if (run("dpkg", ["--verify", name]).trim())
      throw new Error(`V8 toolchain package ${name} failed installed-file integrity`);
    packages[name] = identity;
  }
  const binaries = {};
  for (const name of BINARIES) {
    const path = join(pin.base, "bin", name);
    const version = run(path, ["--version"]).trim();
    if (!new RegExp(`\\b${pin.version.replaceAll(".", "\\.")}\\b`, "u").test(version))
      throw new Error(`V8 toolchain ${name} must be ${pin.version}`);
    binaries[name] = { sha256: hash(path), version };
  }
  const linux = { packages: {}, modules: {} };
  for (const name of LINUX_PACKAGES) {
    linux.packages[name] = run("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${Architecture}\t${Status}", name]).trim();
    if (run("dpkg", ["--verify", name]).trim())
      throw new Error(`V8 Linux prerequisite ${name} failed installed-file integrity`);
  }
  for (const name of GLIB_MODULES)
    linux.modules[name] = run("/usr/bin/pkg-config", ["--modversion", name]).trim();
  validateLinuxPrerequisites(linux);
  const archive = pin.compilerRt.archive;
  const compilerRt = { archive, sha256: hash(archive), objects: assertArm64V8Archive(read(archive)) };
  if (compilerRt.sha256 !== pin.compilerRt.sha256 || compilerRt.objects !== pin.compilerRt.objects)
    throw new Error("V8 compiler-rt archive checksum mismatch");
  return { packages, binaries, linux, compilerRt };
}

function validateToolchain(receipt) {
  validateLinuxPrerequisites(receipt?.linux);
  const pin = LINUX_ARM64_V8_BUILD.toolchain;
  if (receipt?.compilerRt?.archive !== pin.compilerRt.archive ||
    receipt?.compilerRt?.sha256 !== pin.compilerRt.sha256 ||
    receipt?.compilerRt?.objects !== pin.compilerRt.objects)
    throw new Error("V8 compiler-rt receipt is incomplete or mismatched");
  if (
    !receipt ||
    Object.keys(receipt.packages ?? {}).length !== Object.keys(pin.packages).length ||
    Object.keys(receipt.binaries ?? {}).length !== BINARIES.length
  )
    throw new Error("V8 toolchain receipt is incomplete");
  if (receipt.gn?.package !== LINUX_ARM64_V8_BUILD.gnPackage ||
    receipt.gn?.sha256 !== LINUX_ARM64_V8_BUILD.gnSha256 ||
    typeof receipt.gn?.version !== "string" || !receipt.gn.version.includes(LINUX_ARM64_V8_BUILD.gn.slice(0, 8)))
    throw new Error("V8 GN receipt must match the pinned native CIPD package, SHA-256 and revision");
  for (const name of Object.keys(pin.packages)) {
    if (receipt.packages[name] !== `${name}\t${packageVersion(name)}\tarm64\tinstall ok installed`)
      throw new Error("V8 toolchain package identity mismatch");
  }
  for (const name of BINARIES) {
    const binary = receipt.binaries[name];
    if (
      !/^[a-f0-9]{64}$/u.test(binary?.sha256 ?? "") ||
      typeof binary?.version !== "string" ||
      !new RegExp(`\\b${pin.version.replaceAll(".", "\\.")}\\b`, "u").test(binary.version)
    )
      throw new Error(`V8 toolchain binary receipt mismatch: ${name}`);
  }
}

export function createLinuxArm64V8Receipt(root, toolchain) {
  validateToolchain(toolchain);
  const files = payloadFiles(root);
  for (const path of [
    "include/v8.h",
    "include/v8-version.h",
    "libv8_monolith.a",
    "licenses/BUILD-LICENSE",
    ...Object.keys(LICENSES).map((name) => `licenses/${name}`),
  ]) {
    if (!files.includes(path)) throw new Error(`Linux arm64 V8 is missing ${path}`);
  }
  if (sha256(join(root, "licenses/BUILD-LICENSE")) !== CHROMIUM_BUILD_LICENSE.sha256)
    throw new Error("Pinned Chromium build license checksum mismatch");
  const header = readFileSync(join(root, "include/v8-version.h"), "utf8");
  const version = ["MAJOR_VERSION", "MINOR_VERSION", "BUILD_NUMBER", "PATCH_LEVEL"]
    .map((part) => new RegExp(`^#define V8_${part} (\\d+)\\s*$`, "mu").exec(header)?.[1])
    .join(".");
  if (version !== LINUX_ARM64_V8_BUILD.version)
    throw new Error(`Linux arm64 V8 headers do not match ${LINUX_ARM64_V8_BUILD.version}`);
  const objects = assertArm64V8Archive(readFileSync(join(root, "libv8_monolith.a")));
  return {
    schemaVersion: 1,
    build: LINUX_ARM64_V8_BUILD,
    args: linuxArm64V8GnArgs(),
    buildLicense: CHROMIUM_BUILD_LICENSE,
    toolchain,
    objects,
    files: Object.fromEntries(files.map((path) => [path, sha256(join(root, path))])),
  };
}

export function verifyLinuxArm64V8Installation(root) {
  const path = join(root, RECEIPT);
  if (!existsSync(path)) throw new Error(`Linux arm64 V8 build receipt is missing: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    JSON.stringify(receipt.build) !== JSON.stringify(LINUX_ARM64_V8_BUILD) ||
    receipt.args !== linuxArm64V8GnArgs() ||
    JSON.stringify(receipt.buildLicense) !== JSON.stringify(CHROMIUM_BUILD_LICENSE)
  )
    throw new Error("Linux arm64 V8 recipe/flags mismatch");
  const actual = createLinuxArm64V8Receipt(root, receipt.toolchain);
  if (
    JSON.stringify(receipt.files) !== JSON.stringify(actual.files) ||
    receipt.objects !== actual.objects
  )
    throw new Error("Linux arm64 V8 payload checksum/coverage mismatch");
  return actual;
}

// Chromium's pinned layout differs from Ubuntu's; never modify either upstream tree or SDK.
export function prepareLinuxArm64V8Sdk(source, run = execFileSync) {
  const sdk = join(source, SDK);
  rmSync(sdk, { recursive: true, force: true });
  mkdirSync(join(sdk, dirname(BUILTINS)), { recursive: true });
  symlinkSync(join(LINUX_ARM64_V8_BUILD.toolchain.base, "bin"), join(sdk, "bin"));
  symlinkSync("/usr/lib/llvm-18/lib/clang/18/include", join(sdk, "lib/clang/18/include"));
  symlinkSync(LINUX_ARM64_V8_BUILD.toolchain.compilerRt.archive, join(sdk, BUILTINS));
  const input = join(sdk, "preflight.cc");
  const output = join(sdk, "preflight");
  // __multi3 forces a real builtins dependency; headers also exercise Clang's resource lookup.
  writeFileSync(input, "#include <stddef.h>\nextern \"C\" __int128 __multi3(__int128, __int128);\nint main() { return __multi3(6, 7) != 42; }\n");
  run(join(sdk, "bin/clang++"), ["-fuse-ld=lld", input, join(sdk, BUILTINS), "-latomic", "-o", output]);
  const elf = readFileSync(output);
  if (elf.length < 64 || !elf.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
    ![2, 3].includes(elf.readUInt16LE(16)) || elf.readUInt16LE(18) !== 183)
    throw new Error("V8 compiler preflight is not an aarch64 ELF executable");
  run(output, []);
}

export function provisionLinuxArm64V8(destination, { force = false, env = process.env } = {}) {
  const work = join(dirname(destination), ".v8-linux-arm64-source");
  const backup = join(work, "previous");
  if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
  if (!force && existsSync(destination)) {
    try {
      return verifyLinuxArm64V8Installation(destination);
    } catch (error) {
      console.warn(`Replacing stale Linux arm64 V8: ${error.message}`);
    }
  }
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new Error(
      "V8 source build requires a native Linux arm64 host; cross-compilation is unsupported",
    );
  const toolchain = inspectLinuxArm64V8Toolchain();
  const jobs = Number(env.THREENATIVE_V8_BUILD_JOBS ?? 3);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)
    throw new Error("THREENATIVE_V8_BUILD_JOBS must be an integer between 1 and 32");
  const source = join(work, "v8");
  const depot = join(work, "depot_tools");
  const gn = join(source, "buildtools/linux64/gn");
  const stage = join(work, "payload");
  const statePath = join(work, ".recipe.json");
  const state = JSON.stringify({
    build: LINUX_ARM64_V8_BUILD,
    toolchain,
    buildScript: sha256(fileURLToPath(import.meta.url)),
  });
  const baseEnv = {
    ...env,
    DEPOT_TOOLS_UPDATE: "0",
    DEPOT_TOOLS_METRICS: "0",
    PATH: `${depot}:${env.PATH ?? ""}`,
    CC: "/usr/lib/llvm-18/bin/clang",
    CXX: "/usr/lib/llvm-18/bin/clang++",
    AR: "/usr/lib/llvm-18/bin/llvm-ar",
  };
  const run = (program, args, cwd = work) =>
    execFileSync(program, args, { cwd, env: baseEnv, stdio: "inherit" });
  try {
    if (
      force ||
      !existsSync(statePath) ||
      !reusableLinuxArm64V8State(readFileSync(statePath, "utf8"), state, env.THREENATIVE_V8_PACKAGING_REPAIR_SCRIPT_SHA) ||
      !existsSync(gn)
    ) {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      checkoutV8Source(
        depot,
        "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
        LINUX_ARM64_V8_BUILD.depotTools,
        run,
      );
      // Keep DEPS-pinned native GN; skip unused reclient and x64 LLVM without running hooks.
      writeFileSync(
        join(work, ".gclient"),
        `solutions = [{"name": "v8", "url": "https://chromium.googlesource.com/v8/v8.git", "managed": False, "custom_vars": {"checkout_linux": False}, "custom_deps": {"buildtools/reclient": None, "third_party/llvm-build/Release+Asserts": None}}]\n`,
      );
      run(join(depot, "gclient"), [
        "sync",
        "--revision",
        `v8@${LINUX_ARM64_V8_BUILD.source}`,
        "--no-history",
        "--nohooks",
      ]);
      const deps = readFileSync(join(source, "DEPS"), "utf8");
      if (!deps.includes(`'/chromium/src/build.git' + '@' + '${BUILD_REVISION}'`))
        throw new Error("Pinned V8 DEPS Chromium build revision mismatch");
      if (!deps.includes(`'gn_version': 'git_revision:${LINUX_ARM64_V8_BUILD.gn}'`))
        throw new Error("Pinned V8 DEPS GN revision mismatch");
      writeFileSync(statePath, state);
    }
    for (const [directory, revision] of [
      [source, LINUX_ARM64_V8_BUILD.source],
      [depot, LINUX_ARM64_V8_BUILD.depotTools],
      [join(source, "build"), BUILD_REVISION],
    ]) {
      const actual = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      if (actual !== revision) throw new Error(`V8 cached source revision mismatch: ${directory}`);
    }
    const gnBytes = readFileSync(gn);
    if (!gnBytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
      gnBytes.length < 20 || gnBytes.readUInt16LE(18) !== 183 || sha256(gn) !== LINUX_ARM64_V8_BUILD.gnSha256)
      throw new Error("Pinned GN must match the DEPS linux-arm64 CIPD binary SHA-256 and ELF architecture");
    const gnVersion = execFileSync(gn, ["--version"], { env: baseEnv, encoding: "utf8" }).trim();
    if (!gnVersion.includes(LINUX_ARM64_V8_BUILD.gn.slice(0, 8)))
      throw new Error(`Pinned GN version mismatch: ${gnVersion}`);
    toolchain.gn = { package: LINUX_ARM64_V8_BUILD.gnPackage, sha256: sha256(gn), version: gnVersion };
    prepareLinuxArm64V8Sdk(source, run);
    run(gn, ["gen", "out/linux-arm64", `--args=${linuxArm64V8GnArgs()}`], source);
    writeFileSync(statePath, state);
    run("/usr/bin/ninja", [`-j${jobs}`, "-C", "out/linux-arm64", "v8_monolith"], source);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, "licenses"), { recursive: true });
    cpSync(join(source, "include"), join(stage, "include"), { recursive: true });
    copyFileSync(
      join(source, "out/linux-arm64/obj/libv8_monolith.a"),
      join(stage, "libv8_monolith.a"),
    );
    writeFileSync(join(stage, "licenses/BUILD-LICENSE"), fetchChromiumBuildLicense());
    for (const [name, path] of Object.entries(LICENSES))
      copyFileSync(resolve(source, path), join(stage, "licenses", name));
    const receipt = createLinuxArm64V8Receipt(stage, toolchain);
    writeFileSync(join(stage, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
    verifyLinuxArm64V8Installation(stage);
    promoteV8Payload(stage, destination, backup);
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Installed V8; could not clean ${work}: ${error.message}`);
    }
    return receipt;
  } catch (error) {
    throw new Error(
      `Linux arm64 V8 source build failed; previous install is unchanged. Resume from ${work}. ${error.message}`,
      { cause: error },
    );
  }
}

export function runLinuxArm64V8Command(
  args,
  {
    root = resolve(dirname(fileURLToPath(import.meta.url)), "../third_party/v8-linux-arm64"),
    verify = verifyLinuxArm64V8Installation,
    provision = provisionLinuxArm64V8,
  } = {},
) {
  if (args.length > 1 || args.some((arg) => !["--verify", "--force"].includes(arg)))
    throw new Error("Usage: build-linux-arm64-v8.mjs [--verify | --force]");
  if (args[0] === "--verify") return verify(root);
  return provision(root, { force: args[0] === "--force" });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runLinuxArm64V8Command(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
