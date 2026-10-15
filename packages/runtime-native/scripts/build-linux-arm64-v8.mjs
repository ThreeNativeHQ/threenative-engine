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
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native Ubuntu noble arm64 packages; producer installs these exact versions before invoking us.
export const LINUX_ARM64_V8_BUILD = Object.freeze({
  recipe: 1,
  version: "13.1.201.22",
  source: "9c09e7876ff830e1f9a731aa930040d1028ff5a1",
  depotTools: "08f3e8c0eb66d6de3a048a757d0ff708dbc8ea34",
  gn: "95b0f8fe31a992a33c040bbe3867901335c12762",
  toolchain: Object.freeze({
    base: "/usr/lib/llvm-18",
    version: "18.1.3",
    packageVersion: "1:18.1.3-1ubuntu1",
    architecture: "arm64",
    index:
      "https://ports.ubuntu.com/ubuntu-ports/dists/noble-updates/universe/binary-arm64/Packages.xz",
    packages: Object.freeze({
      "clang-18": "e3a70e054d3c0d0841cd7d1555deeab82d75609d34438b1cfc1b187b0add7d77",
      "lld-18": "c33a2e048536e6d902a9f209d114d049b5becbedb94d11eb77f313cad95a830c",
      "llvm-18": "1d9c87ff9fe17d0ee00703ec0f339ab687e2807b3508b51cf517e05281de104d",
    }),
  }),
});
const RECEIPT = "build-receipt.json";
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
  "BUILD-LICENSE": "build/LICENSE",
  "GN-LICENSE": "../gn/LICENSE",
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
    `clang_base_path="${LINUX_ARM64_V8_BUILD.toolchain.base}"`,
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

export function inspectLinuxArm64V8Toolchain({
  run = (program, args) => execFileSync(program, args, { encoding: "utf8" }),
  hash = sha256,
} = {}) {
  const pin = LINUX_ARM64_V8_BUILD.toolchain;
  const packages = {};
  for (const name of Object.keys(pin.packages)) {
    const identity = run("dpkg-query", [
      "-W",
      "-f=${Package}\t${Version}\t${Architecture}\t${Status}",
      name,
    ]).trim();
    if (identity !== `${name}\t${pin.packageVersion}\tarm64\tinstall ok installed`)
      throw new Error(`V8 requires native ${name}=${pin.packageVersion}: ${identity}`);
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
  return { packages, binaries };
}

function validateToolchain(receipt) {
  const pin = LINUX_ARM64_V8_BUILD.toolchain;
  if (
    !receipt ||
    Object.keys(receipt.packages ?? {}).length !== Object.keys(pin.packages).length ||
    Object.keys(receipt.binaries ?? {}).length !== BINARIES.length
  )
    throw new Error("V8 toolchain receipt is incomplete");
  for (const name of Object.keys(pin.packages)) {
    if (receipt.packages[name] !== `${name}\t${pin.packageVersion}\tarm64\tinstall ok installed`)
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
    ...Object.keys(LICENSES).map((name) => `licenses/${name}`),
  ]) {
    if (!files.includes(path)) throw new Error(`Linux arm64 V8 is missing ${path}`);
  }
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
    receipt.args !== linuxArm64V8GnArgs()
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
  const gn = join(work, "gn");
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
      readFileSync(statePath, "utf8") !== state ||
      !existsSync(join(gn, "out/gn"))
    ) {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      checkoutV8Source(
        depot,
        "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
        LINUX_ARM64_V8_BUILD.depotTools,
        run,
      );
      // Skip binary GN, reclient and x64 LLVM at sync time, not merely their hooks.
      writeFileSync(
        join(work, ".gclient"),
        `solutions = [{"name": "v8", "url": "https://chromium.googlesource.com/v8/v8.git", "managed": False, "custom_vars": {"checkout_linux": False}, "custom_deps": {"v8/buildtools/linux64": None, "v8/buildtools/reclient": None, "v8/third_party/llvm-build/Release+Asserts": None}}]\n`,
      );
      run(join(depot, "gclient"), [
        "sync",
        "--revision",
        `v8@${LINUX_ARM64_V8_BUILD.source}`,
        "--no-history",
        "--nohooks",
      ]);
      const deps = readFileSync(join(source, "DEPS"), "utf8");
      if (!deps.includes(`'gn_version': 'git_revision:${LINUX_ARM64_V8_BUILD.gn}'`))
        throw new Error("Pinned V8 DEPS GN revision mismatch");
      checkoutV8Source(gn, "https://gn.googlesource.com/gn.git", LINUX_ARM64_V8_BUILD.gn, run);
      // GN's version generator describes HEAD relative to this tag; a depth-one checkout cannot.
      run(
        "git",
        [
          "fetch",
          "--unshallow",
          "https://gn.googlesource.com/gn.git",
          LINUX_ARM64_V8_BUILD.gn,
          "refs/tags/initial-commit:refs/tags/initial-commit",
        ],
        gn,
      );
      run("python3", ["build/gen.py"], gn);
      run("/usr/bin/ninja", [`-j${jobs}`, "-C", "out"], gn);
      // GN normally lives here in the V8 source tree; install our native bootstrap instead.
      mkdirSync(join(source, "buildtools/linux64"), { recursive: true });
      copyFileSync(join(gn, "out/gn"), join(source, "buildtools/linux64/gn"));
      writeFileSync(statePath, state);
    }
    for (const [directory, revision] of [
      [source, LINUX_ARM64_V8_BUILD.source],
      [depot, LINUX_ARM64_V8_BUILD.depotTools],
      [gn, LINUX_ARM64_V8_BUILD.gn],
    ]) {
      const actual = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      if (actual !== revision) throw new Error(`V8 cached source revision mismatch: ${directory}`);
    }
    run(join(gn, "out/gn"), ["gen", "out/linux-arm64", `--args=${linuxArm64V8GnArgs()}`], source);
    run("/usr/bin/ninja", [`-j${jobs}`, "-C", "out/linux-arm64", "v8_monolith"], source);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, "licenses"), { recursive: true });
    cpSync(join(source, "include"), join(stage, "include"), { recursive: true });
    copyFileSync(
      join(source, "out/linux-arm64/obj/libv8_monolith.a"),
      join(stage, "libv8_monolith.a"),
    );
    for (const [name, path] of Object.entries(LICENSES))
      copyFileSync(join(source, path), join(stage, "licenses", name));
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
