import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_BUILD_LICENSE,
  LINUX_ARM64_V8_BUILD,
  assertArm64V8Archive,
  createLinuxArm64V8Receipt,
  fetchChromiumBuildLicense,
  inspectLinuxArm64V8Toolchain,
  linuxArm64V8GnArgs,
  prepareLinuxArm64V8Sdk,
  provisionLinuxArm64V8,
  reusableLinuxArm64V8State,
  runLinuxArm64V8Command,
  verifyLinuxArm64V8Installation,
} from "../../packages/runtime-native/scripts/build-linux-arm64-v8.mjs";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

import { promoteV8Payload } from "../../packages/runtime-native/scripts/build-linux-arm64-v8.mjs";

const chromiumLicense = Buffer.from(
  "Ly8gQ29weXJpZ2h0IDIwMTUgVGhlIENocm9taXVtIEF1dGhvcnMKLy8KLy8gUmVkaXN0cmlidXRpb24gYW5kIHVzZSBpbiBzb3VyY2UgYW5kIGJpbmFyeSBmb3Jtcywgd2l0aCBvciB3aXRob3V0Ci8vIG1vZGlmaWNhdGlvbiwgYXJlIHBlcm1pdHRlZCBwcm92aWRlZCB0aGF0IHRoZSBmb2xsb3dpbmcgY29uZGl0aW9ucyBhcmUKLy8gbWV0OgovLwovLyAgICAqIFJlZGlzdHJpYnV0aW9ucyBvZiBzb3VyY2UgY29kZSBtdXN0IHJldGFpbiB0aGUgYWJvdmUgY29weXJpZ2h0Ci8vIG5vdGljZSwgdGhpcyBsaXN0IG9mIGNvbmRpdGlvbnMgYW5kIHRoZSBmb2xsb3dpbmcgZGlzY2xhaW1lci4KLy8gICAgKiBSZWRpc3RyaWJ1dGlvbnMgaW4gYmluYXJ5IGZvcm0gbXVzdCByZXByb2R1Y2UgdGhlIGFib3ZlCi8vIGNvcHlyaWdodCBub3RpY2UsIHRoaXMgbGlzdCBvZiBjb25kaXRpb25zIGFuZCB0aGUgZm9sbG93aW5nIGRpc2NsYWltZXIKLy8gaW4gdGhlIGRvY3VtZW50YXRpb24gYW5kL29yIG90aGVyIG1hdGVyaWFscyBwcm92aWRlZCB3aXRoIHRoZQovLyBkaXN0cmlidXRpb24uCi8vICAgICogTmVpdGhlciB0aGUgbmFtZSBvZiBHb29nbGUgTExDIG5vciB0aGUgbmFtZXMgb2YgaXRzCi8vIGNvbnRyaWJ1dG9ycyBtYXkgYmUgdXNlZCB0byBlbmRvcnNlIG9yIHByb21vdGUgcHJvZHVjdHMgZGVyaXZlZCBmcm9tCi8vIHRoaXMgc29mdHdhcmUgd2l0aG91dCBzcGVjaWZpYyBwcmlvciB3cml0dGVuIHBlcm1pc3Npb24uCi8vCi8vIFRISVMgU09GVFdBUkUgSVMgUFJPVklERUQgQlkgVEhFIENPUFlSSUdIVCBIT0xERVJTIEFORCBDT05UUklCVVRPUlMKLy8gIkFTIElTIiBBTkQgQU5ZIEVYUFJFU1MgT1IgSU1QTElFRCBXQVJSQU5USUVTLCBJTkNMVURJTkcsIEJVVCBOT1QKLy8gTElNSVRFRCBUTywgVEhFIElNUExJRUQgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFkgQU5EIEZJVE5FU1MgRk9SCi8vIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFSRSBESVNDTEFJTUVELiBJTiBOTyBFVkVOVCBTSEFMTCBUSEUgQ09QWVJJR0hUCi8vIE9XTkVSIE9SIENPTlRSSUJVVE9SUyBCRSBMSUFCTEUgRk9SIEFOWSBESVJFQ1QsIElORElSRUNULCBJTkNJREVOVEFMLAovLyBTUEVDSUFMLCBFWEVNUExBUlksIE9SIENPTlNFUVVFTlRJQUwgREFNQUdFUyAoSU5DTFVESU5HLCBCVVQgTk9UCi8vIExJTUlURUQgVE8sIFBST0NVUkVNRU5UIE9GIFNVQlNUSVRVVEUgR09PRFMgT1IgU0VSVklDRVM7IExPU1MgT0YgVVNFLAovLyBEQVRBLCBPUiBQUk9GSVRTOyBPUiBCVVNJTkVTUyBJTlRFUlJVUFRJT04pIEhPV0VWRVIgQ0FVU0VEIEFORCBPTiBBTlkKLy8gVEhFT1JZIE9GIExJQUJJTElUWSwgV0hFVEhFUiBJTiBDT05UUkFDVCwgU1RSSUNUIExJQUJJTElUWSwgT1IgVE9SVAovLyAoSU5DTFVESU5HIE5FR0xJR0VOQ0UgT1IgT1RIRVJXSVNFKSBBUklTSU5HIElOIEFOWSBXQVkgT1VUIE9GIFRIRSBVU0UKLy8gT0YgVEhJUyBTT0ZUV0FSRSwgRVZFTiBJRiBBRFZJU0VEIE9GIFRIRSBQT1NTSUJJTElUWSBPRiBTVUNIIERBTUFHRS4K",
  "base64",
);
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
          ? `${args.at(-1)}\t${args.at(-1) === "libclang-rt-18-dev" ? "1:18.1.3-1" : "1:18.1.3-1ubuntu1"}\tarm64\tinstall ok installed`
          : program === "dpkg"
            ? ""
            : program === "/usr/bin/pkg-config"
              ? "2.80.0"
              : `LLVM version ${version}`,
      hash: (path: string) =>
        path.endsWith(".a") ? LINUX_ARM64_V8_BUILD.toolchain.compilerRt.sha256 : "a".repeat(64),
      read: () =>
        Buffer.concat([archive(), ...Array.from({ length: 277 }, () => archive().subarray(8))]),
    }),
    gn: {
      package: LINUX_ARM64_V8_BUILD.gnPackage,
      sha256: LINUX_ARM64_V8_BUILD.gnSha256,
      version: "2200 (95b0f8fe31a9)",
    },
  };
}
function fixture() {
  const root = makeTempDirSync("linux-arm64-v8-");

  mkdirSync(join(root, "include"));
  mkdirSync(join(root, "licenses"));
  writeFileSync(join(root, "include/v8.h"), "// fixture");
  writeFileSync(
    join(root, "include/v8-version.h"),
    ["MAJOR_VERSION 13", "MINOR_VERSION 1", "BUILD_NUMBER 201", "PATCH_LEVEL 22"]
      .map((part) => `#define V8_${part}\n`)
      .join(""),
  );
  for (const name of [
    "V8-LICENSE",
    "V8-LICENSE.v8",
    "V8-FDLIBM",
    "V8-STRONGTALK",
    "BUILD-LICENSE",
    "COMPILER-RT-COPYRIGHT",
  ])
    writeFileSync(join(root, "licenses", name), "license fixture");
  writeFileSync(join(root, "licenses/BUILD-LICENSE"), chromiumLicense);
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
    const parent = makeTempDirSync("v8-recovery-");

    const work = join(parent, ".v8-linux-arm64-source");
    mkdirSync(work);
    renameSync(root, join(work, "previous"));
    const destination = join(parent, "v8-linux-arm64");
    expect(provisionLinuxArm64V8(destination).objects).toBe(1);
  });
  it("restores the previous payload if promotion fails", () => {
    const root = fixture();
    const parent = makeTempDirSync("v8-promotion-");

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
      'clang_base_path="//.threenative-llvm-18"',
      'clang_version="18"',
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
        ? `${args.at(-1)}\t${args.at(-1) === "libclang-rt-18-dev" ? "1:18.1.3-1" : "1:18.1.3-1ubuntu1"}\tarm64\tinstall ok installed`
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
  it("rejects absent, substituted or incomplete compiler-rt receipts", () => {
    for (const corrupt of [
      (rt: Record<string, unknown>) => {
        rt.sha256 = "a".repeat(64);
      },
      (rt: Record<string, unknown>) => {
        rt.objects = 1;
      },
      (rt: Record<string, unknown>) => {
        Reflect.deleteProperty(rt, "archive");
      },
    ]) {
      const root = fixture();
      editReceipt(root, (receipt) => corrupt(receipt.toolchain.compilerRt));
      expect(() => verifyLinuxArm64V8Installation(root)).toThrow("compiler-rt receipt");
    }
  });
  it("adapts only the private SDK and requires a native preflight executable to run", () => {
    const root = makeTempDirSync("v8-sdk-");

    const run = vi.fn((_program: string, args: string[]) => {
      if (args.length) {
        const elf = archive().subarray(68);
        elf.writeUInt16LE(3, 16);
        const output = args.at(-1);
        if (output === undefined) throw new Error("missing preflight output argument");
        writeFileSync(output, elf);
      }
    });
    prepareLinuxArm64V8Sdk(root, run);
    const sdk = join(root, ".threenative-llvm-18");
    expect(readlinkSync(join(sdk, "bin"))).toBe("/usr/lib/llvm-18/bin");
    expect(readlinkSync(join(sdk, "lib/clang/18/include"))).toBe(
      "/usr/lib/llvm-18/lib/clang/18/include",
    );
    const builtins = join(sdk, "lib/clang/18/lib/aarch64-unknown-linux-gnu/libclang_rt.builtins.a");
    expect(readlinkSync(builtins)).toBe(LINUX_ARM64_V8_BUILD.toolchain.compilerRt.archive);
    expect(run.mock.calls[0]?.[1]).toContain(builtins);
    expect(run.mock.calls[1]).toEqual([join(sdk, "preflight"), []]);
    expect(() =>
      prepareLinuxArm64V8Sdk(root, (_program: string, args: string[]) => {
        const output = args.at(-1);
        if (output === undefined) throw new Error("missing preflight output argument");
        writeFileSync(output, archive(62).subarray(68));
      }),
    ).toThrow("aarch64 ELF executable");
    expect(() =>
      prepareLinuxArm64V8Sdk(root, () => {
        throw new Error("link failed");
      }),
    ).toThrow("link failed");
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

describe("packaging-only source-cache migration", () => {
  it("pins the migration destination to the final producer bytes in CI", () => {
    const workflow = readFileSync(".github/workflows/native-platforms.yml", "utf8");
    const pin = workflow.match(/THREENATIVE_V8_PACKAGING_REPAIR_SCRIPT_SHA: ([a-f0-9]{64})/u)?.[1];
    const actual = createHash("sha256")
      .update(readFileSync("packages/runtime-native/scripts/build-linux-arm64-v8.mjs"))
      .digest("hex");
    expect(pin).toBe(actual);
  });

  const previousScript = "3a5872301fb0fb8b9ed380b1172ca15de414fa370e23812356c736ffc233b1e8";
  const expected = {
    build: LINUX_ARM64_V8_BUILD,
    toolchain: toolchain(),
    buildScript: "b".repeat(64),
  };
  it("accepts only the exact previous script with otherwise identical full state", () => {
    expect(reusableLinuxArm64V8State(JSON.stringify(expected), JSON.stringify(expected))).toBe(
      true,
    );
    expect(
      reusableLinuxArm64V8State(
        JSON.stringify({ ...expected, buildScript: previousScript }),
        JSON.stringify(expected),
        expected.buildScript,
      ),
    ).toBe(true);
    for (const changed of [
      { ...expected, buildScript: "c".repeat(64) },
      { ...expected, buildScript: previousScript, build: { ...expected.build, source: "wrong" } },
      {
        ...expected,
        buildScript: previousScript,
        toolchain: { ...expected.toolchain, compilerRt: { sha256: "wrong" } },
      },
      { ...expected, buildScript: previousScript, unexpected: true },
    ])
      expect(
        reusableLinuxArm64V8State(
          JSON.stringify(changed),
          JSON.stringify(expected),
          expected.buildScript,
        ),
      ).toBe(false);
  });
  it("rejects predecessor reuse by a future script even with unchanged build and toolchain", () => {
    const old = JSON.stringify({ ...expected, buildScript: previousScript });
    const future = JSON.stringify({ ...expected, buildScript: "c".repeat(64) });
    expect(reusableLinuxArm64V8State(old, future, expected.buildScript)).toBe(false);
    expect(reusableLinuxArm64V8State(old, JSON.stringify(expected))).toBe(false);
    expect(reusableLinuxArm64V8State(old, JSON.stringify(expected), "wrong")).toBe(false);
  });
  it("fetches the exact owning Chromium license and rejects missing or altered bytes", () => {
    const run = vi.fn(() => Buffer.from(chromiumLicense.toString("base64")));
    expect(fetchChromiumBuildLicense(run)).toEqual(chromiumLicense);
    expect(run.mock.calls[0]).toEqual([
      "curl",
      ["--fail", "--location", "--silent", "--show-error", CHROMIUM_BUILD_LICENSE.url],
    ]);
    expect(() => fetchChromiumBuildLicense(() => Buffer.from(""))).toThrow("checksum mismatch");
    const altered = Buffer.from(chromiumLicense);
    altered.writeUInt8(altered.readUInt8(0) ^ 1, 0);
    expect(() => fetchChromiumBuildLicense(() => Buffer.from(altered.toString("base64")))).toThrow(
      "checksum mismatch",
    );
    expect(() =>
      fetchChromiumBuildLicense(() => {
        throw new Error("404");
      }),
    ).toThrow("404");
    const root = fixture();
    writeFileSync(join(root, "licenses/BUILD-LICENSE"), altered);
    expect(() => createLinuxArm64V8Receipt(root, toolchain())).toThrow("checksum mismatch");
  });
});
