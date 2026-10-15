import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_ARM64_V8_BUILD,
  assertArm64V8Archive,
  createLinuxArm64V8Receipt,
  inspectLinuxArm64V8Toolchain,
  linuxArm64V8GnArgs,
  provisionLinuxArm64V8,
  runLinuxArm64V8Command,
  verifyLinuxArm64V8Installation,
} from "../../packages/runtime-native/scripts/build-linux-arm64-v8.mjs";

import { promoteV8Payload } from "../../packages/runtime-native/scripts/build-linux-arm64-v8.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function archive(machine = 183, name = "object.o/", type = 1) {
  const elf = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(type, 16);
  elf.writeUInt16LE(machine, 18);
  return Buffer.concat([
    Buffer.from("!<arch>\n"),
    Buffer.from(
      `${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"644".padEnd(8)}${String(elf.length).padEnd(10)}\`\n`,
    ),
    elf,
  ]);
}
const version = LINUX_ARM64_V8_BUILD.toolchain.version;
function toolchain() {
  return {
    ...inspectLinuxArm64V8Toolchain({
      run: (program: string, args: string[]) =>
        program === "dpkg-query"
          ? `${args.at(-1)}\t1:18.1.3-1ubuntu1\tarm64\tinstall ok installed`
          : program === "dpkg"
            ? ""
            : program === "/usr/bin/pkg-config"
              ? "2.80.0"
              : `LLVM version ${version}`,
      hash: () => "a".repeat(64),
    }),
    gn: {
      package: LINUX_ARM64_V8_BUILD.gnPackage,
      sha256: LINUX_ARM64_V8_BUILD.gnSha256,
      version: "2200 (95b0f8fe31a9)",
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "linux-arm64-v8-"));
  roots.push(root);
  mkdirSync(join(root, "include"));
  mkdirSync(join(root, "licenses"));
  writeFileSync(join(root, "include/v8.h"), "// fixture");
  writeFileSync(
    join(root, "include/v8-version.h"),
    ["MAJOR_VERSION 13", "MINOR_VERSION 1", "BUILD_NUMBER 201", "PATCH_LEVEL 22"]
      .map((part) => `#define V8_${part}\n`)
      .join(""),
  );
  for (const name of ["V8-LICENSE", "V8-LICENSE.v8", "V8-FDLIBM", "V8-STRONGTALK", "BUILD-LICENSE"])
    writeFileSync(join(root, "licenses", name), "license fixture");
  writeFileSync(join(root, "libv8_monolith.a"), archive());
  const receipt = createLinuxArm64V8Receipt(root, toolchain());
  writeFileSync(join(root, "build-receipt.json"), JSON.stringify(receipt));
  return root;
}
function editReceipt(
  root: string,
  edit: (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => void,
) {
  const path = join(root, "build-receipt.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  edit(receipt);
  writeFileSync(path, JSON.stringify(receipt));
}

describe("Linux arm64 V8 receipt", () => {
  it("verifies through the command consumer without provisioning", () => {
    const root = fixture();
    const provision = vi.fn(() => {
      throw new Error("must not build");
    });
    expect(runLinuxArm64V8Command(["--verify"], { root, provision }).objects).toBe(1);
    expect(provision).not.toHaveBeenCalled();
  });
  it("fails for a missing receipt or required license", () => {
    const root = fixture();
    rmSync(join(root, "build-receipt.json"));
    expect(() => runLinuxArm64V8Command(["--verify"], { root })).toThrow("receipt is missing");
    rmSync(join(root, "licenses/BUILD-LICENSE"));
    expect(() => createLinuxArm64V8Receipt(root, toolchain())).toThrow(
      "missing licenses/BUILD-LICENSE",
    );
  });
  it("rejects GN receipt substitutions in package, binary hash and revision", () => {
    for (const field of ["package", "sha256", "version"] as const) {
      const root = fixture();
      editReceipt(root, (receipt) => {
        receipt.toolchain.gn[field] = "wrong";
      });
      expect(() => verifyLinuxArm64V8Installation(root)).toThrow("GN receipt");
    }
  });
  it("rejects missing Linux development package identities and GLib modules", () => {
    for (const corrupt of [
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        receipt.toolchain.linux.packages["libglib2.0-dev"] =
          "libglib2.0-dev\t2.80.0-6ubuntu3\tamd64\tinstall ok installed";
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        Reflect.deleteProperty(receipt.toolchain.linux.packages, "pkg-config");
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        receipt.toolchain.linux.modules["gobject-2.0"] = "";
      },
    ]) {
      const root = fixture();
      editReceipt(root, corrupt);
      expect(() => verifyLinuxArm64V8Installation(root)).toThrow("Linux prerequisite");
    }
  });
  it.each(["tamper", "extra", "empty", "symlink"])("rejects %s payloads", (kind) => {
    const root = fixture();
    if (kind === "tamper") writeFileSync(join(root, "include/v8.h"), "changed");
    if (kind === "extra") writeFileSync(join(root, "extra"), "unrecorded");
    if (kind === "empty") writeFileSync(join(root, "extra"), "");
    if (kind === "symlink") symlinkSync(join(root, "include/v8.h"), join(root, "extra"));
    expect(() => verifyLinuxArm64V8Installation(root)).toThrow();
  });
  it("rejects mismatched headers, recipe, flags and incomplete hashes", () => {
    const root = fixture();
    writeFileSync(join(root, "include/v8-version.h"), "#define V8_MAJOR_VERSION 12\n");
    expect(() => verifyLinuxArm64V8Installation(root)).toThrow("headers do not match");
    for (const edit of [
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        receipt.build = { ...receipt.build, recipe: receipt.build.recipe + 1 };
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        receipt.args += ' host_cpu="x64"';
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        Reflect.deleteProperty(receipt.files, "include/v8.h");
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        receipt.toolchain.packages["clang-18"] = "untrusted";
      },
      (receipt: ReturnType<typeof createLinuxArm64V8Receipt>) => {
        Reflect.deleteProperty(receipt.toolchain.binaries, "clang");
      },
    ]) {
      const other = fixture();
      editReceipt(other, edit);
      expect(() => verifyLinuxArm64V8Installation(other)).toThrow();
    }
  });
  it("refuses a wrong-architecture object even with freshly computed hashes", () => {
    const root = fixture();
    writeFileSync(join(root, "libv8_monolith.a"), archive(62));
    expect(() => createLinuxArm64V8Receipt(root, toolchain())).toThrow("not an aarch64 ELF");
  });
});

describe("payload promotion and recovery", () => {
  it("reuses a verified payload without requiring a compiler on the consumer", () => {
    const root = fixture();
    expect(provisionLinuxArm64V8(root).build.version).toBe("13.1.201.22");
  });
  it("recovers a prior install after interrupted promotion", () => {
    const root = fixture();
    const parent = mkdtempSync(join(tmpdir(), "v8-recovery-"));
    roots.push(parent);
    const work = join(parent, ".v8-linux-arm64-source");
    mkdirSync(work);
    renameSync(root, join(work, "previous"));
    const destination = join(parent, "v8-linux-arm64");
    expect(provisionLinuxArm64V8(destination).objects).toBe(1);
  });
  it("restores the previous payload if promotion fails", () => {
    const root = fixture();
    const parent = mkdtempSync(join(tmpdir(), "v8-promotion-"));
    roots.push(parent);
    const backup = join(parent, "previous");
    expect(() => promoteV8Payload(join(parent, "missing-stage"), root, backup)).toThrow();
    expect(verifyLinuxArm64V8Installation(root).objects).toBe(1);
    const stage = fixture();
    promoteV8Payload(stage, root, backup);
    expect(verifyLinuxArm64V8Installation(root).objects).toBe(1);
    expect(verifyLinuxArm64V8Installation(backup).objects).toBe(1);
  });
});

describe("archive validation", () => {
  it("checks every object, not just the first", () => {
    expect(assertArm64V8Archive(archive())).toBe(1);
    expect(() => assertArm64V8Archive(Buffer.concat([archive(), archive(62).subarray(8)]))).toThrow(
      "aarch64 ELF",
    );
    expect(() => assertArm64V8Archive(archive(183, "object.o/", 3))).toThrow("relocatable");
  });
  it.each([Buffer.from("!<thin>\n"), Buffer.from("!<arch>\n"), archive().subarray(0, 100)])(
    "rejects thin, empty and truncated archives",
    (bytes) => {
      expect(() => assertArm64V8Archive(bytes)).toThrow();
    },
  );
  it("allows GNU name tables but never counts metadata as objects", () => {
    const table = archive().subarray(0, 68);
    table.write("//".padEnd(16), 8);
    table.write("0".padEnd(10), 56);
    expect(assertArm64V8Archive(Buffer.concat([table, archive(183, "/0").subarray(8)]))).toBe(1);
    expect(() => assertArm64V8Archive(table)).toThrow("no objects");
  });
});

describe("recipe and toolchain", () => {
  it("matches the desktop monolith ABI using the native compiler", () => {
    const args = linuxArm64V8GnArgs();
    for (const arg of [
      'target_cpu="arm64"',
      "v8_monolithic=true",
      "v8_enable_pointer_compression=false",
      "v8_enable_sandbox=false",
      "v8_use_external_startup_data=false",
      "use_sysroot=false",
      "use_custom_libcxx=false",
      "clang_use_chrome_plugins=false",
      'clang_base_path="/usr/lib/llvm-18"',
      "use_lld=true",
    ])
      expect(args).toContain(arg);
    expect(args).not.toContain("x64");
  });
  it("rejects wrong package identities, modified installs and wrong compiler versions", () => {
    for (const output of [
      "clang-18\twrong\tarm64\tinstall ok installed",
      "clang-18\t1:18.1.3-1ubuntu1\tamd64\tinstall ok installed",
    ])
      expect(() => inspectLinuxArm64V8Toolchain({ run: () => output })).toThrow("requires native");
    const run = (program: string, args: string[]) =>
      program === "dpkg-query"
        ? `${args.at(-1)}\t1:18.1.3-1ubuntu1\tarm64\tinstall ok installed`
        : program === "dpkg"
          ? "modified"
          : "clang version 20.0.0";
    expect(() => inspectLinuxArm64V8Toolchain({ run })).toThrow("installed-file integrity");
    expect(() =>
      inspectLinuxArm64V8Toolchain({
        run: (program: string, args: string[]) => (program === "dpkg" ? "" : run(program, args)),
      }),
    ).toThrow("must be 18.1.3");
  });
  it("validates command flags and routes --force", () => {
    const provision = vi.fn();
    runLinuxArm64V8Command(["--force"], { root: "/unused", provision });
    expect(provision).toHaveBeenCalledWith("/unused", { force: true });
    for (const args of [["--wat"], ["--verify", "--force"]])
      expect(() => runLinuxArm64V8Command(args, { provision })).toThrow("Usage");
  });
  it("the real CLI fails closed for unsupported flags", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("packages/runtime-native/scripts/build-linux-arm64-v8.mjs"), "--wat"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
