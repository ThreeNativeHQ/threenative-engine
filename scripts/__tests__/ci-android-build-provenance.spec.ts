import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
const { inspectAndroidBuildProvenance, runtimeOptimizationProof } = await import(
  new URL("../ci-android-build-provenance.mjs", import.meta.url).href
);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
describe("exact APK compiler-to-packaging provenance", () => {
  it.each(
    ["out/lib", "mergeDebugNativeLibs/out/lib"].flatMap((layout) =>
      ["3.22.1", "3.22.1-g37088a8", "3.22.1-g37088a8-dirty"].map((version) => [layout, version]),
    ),
  )(
    "binds %s with compiler metadata version %s and exact configured stripping proof",
    (layout, version) => {
      const root = makeTempDirSync("android-packaging-proof-");
      const put = (name: string, bytes: string) => {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        return file;
      };
      try {
        put(
          `android/app/build/intermediates/merged_native_libs/debug/${layout}/x86_64/libmystral-runtime.so`,
          "compiled-with-symbols",
        );
        const library = put(
          "android/app/build/intermediates/cxx/Debug/current/obj/x86_64/libmystral-runtime.so",
          "compiled-with-symbols",
        );
        const strip = put(
          "ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip",
          "mock tool; never executed",
        );
        const compiler = put(
          "ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++",
          "mock compiler; never executed",
        );
        const cache = put(
          "android/app/.cxx/Debug/current/x86_64/CMakeCache.txt",
          `CMAKE_STRIP:FILEPATH=${strip}\nCMAKE_CXX_COMPILER:FILEPATH=${compiler}\nCMAKE_ANDROID_NDK:PATH=${path.join(root, "ndk")}\n`,
        );
        const ninjaBytes = (flags: string) =>
          `build CMakeFiles/mystral-runtime.dir/runtime.cpp.o: CXX_COMPILER__mystral-runtime_Debug /src/runtime.cpp\n  FLAGS = ${flags}\nbuild ${library}: CXX_SHARED_LIBRARY_LINKER__mystral-runtime_Debug CMakeFiles/mystral-runtime.dir/runtime.cpp.o\n`;
        const ninja = put("android/app/.cxx/Debug/current/x86_64/build.ninja", ninjaBytes("-O2"));
        put(
          "android/app/.cxx/Debug/current/x86_64/CMakeFiles/rules.ninja",
          "rule CXX_COMPILER__mystral-runtime_Debug\n  command = clang++ $DEFINES $INCLUDES $FLAGS -c $in -o $out\n",
        );
        const execute = (command: string, args: string[]) => {
          expect(command).toBe(strip);
          expect(args[0]).toBe("--strip-unneeded");
          expect(args[1]).toBe("-o");
          expect(args[3]).toBe(library);
          const output = args[2];
          if (!output) throw new Error("strip proof output is missing");
          writeFileSync(output, "packaged");
        };
        expect(
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute).artifactSha256,
        ).toBe(hash("packaged"));
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("wrong-apk"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
        const metadata = put(
          `android/app/.cxx/Debug/current/x86_64/CMakeFiles/${version}/CMakeCXXCompiler.cmake`,
          `set(CMAKE_CXX_COMPILER "${compiler}")\n`,
        );
        // Exact pinned NDK r28c normal-variable/CMake 3.22.1 producer shape:
        // compiler absent from cache, recorded in generated compiler metadata.
        writeFileSync(
          cache,
          `CMAKE_STRIP:FILEPATH=${strip}\nANDROID_NDK:UNINITIALIZED=${path.join(root, "ndk")}\n`,
        );
        expect(
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute).artifactSha256,
        ).toBe(hash("packaged"));
        writeFileSync(metadata, 'set(CMAKE_CXX_COMPILER "/different/toolchain/clang++")\n');
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
        writeFileSync(
          metadata,
          `set(CMAKE_CXX_COMPILER "${compiler}")\nset(CMAKE_CXX_COMPILER "/different/toolchain/clang++")\n`,
        );
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
        writeFileSync(metadata, `set(CMAKE_CXX_COMPILER "${compiler}")\n`);
        const unsupported = put(
          "android/app/.cxx/Debug/current/x86_64/CMakeFiles/3.22.1-unsupported/CMakeCXXCompiler.cmake",
          'set(CMAKE_CXX_COMPILER "/different/toolchain/clang++")\n',
        );
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
        rmSync(unsupported);
        for (const unsafe of [
          ninjaBytes("-O2 -O0"),
          `${ninjaBytes("-O0")}build unrelated.o: unrelated other.cpp\n  FLAGS = -O2\n`,
        ]) {
          writeFileSync(ninja, unsafe);
          expect(() =>
            inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
          ).toThrow("PROVENANCE_AMBIGUOUS");
        }
        writeFileSync(ninja, ninjaBytes("-O0"));
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_AMBIGUOUS");
        writeFileSync(ninja, ninjaBytes("-O2"));
        writeFileSync(
          cache,
          `CMAKE_STRIP:FILEPATH=${strip}\nCMAKE_CXX_COMPILER:FILEPATH=/different/toolchain/clang++\n`,
        );
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
        writeFileSync(library, "stale-other-build");
        expect(() =>
          inspectAndroidBuildProvenance("x86_64", hash("packaged"), root, execute),
        ).toThrow("PROVENANCE_MISSING");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("runtime-own effective Android optimization", () => {
  const library = "/build/libmystral-runtime.so";
  const rules =
    "rule CXX_COMPILER__mystral-runtime_Debug\n  command = clang++ $DEFINES $INCLUDES $FLAGS -c $in -o $out\n";
  const ninja = (flags: string) =>
    `build CMakeFiles/mystral-runtime.dir/runtime.cpp.o: CXX_COMPILER__mystral-runtime_Debug /src/runtime.cpp\n  FLAGS = ${flags}\nbuild ${library}: CXX_SHARED_LIBRARY_LINKER__mystral-runtime_Debug CMakeFiles/mystral-runtime.dir/runtime.cpp.o\n`;
  it("rejects unrelated O2 and an effective O0 override but accepts effective runtime O2", () => {
    expect(
      runtimeOptimizationProof(
        `${ninja("-O0")}build other.o: other other.cpp\n  FLAGS = -O2\n`,
        rules,
        library,
        "/build",
      ).optimization,
    ).toBe("other");
    expect(runtimeOptimizationProof(ninja("-O2 -O0"), rules, library, "/build").optimization).toBe(
      "other",
    );
    expect(runtimeOptimizationProof(ninja("-O0 -O2"), rules, library, "/build").optimization).toBe(
      "-O2",
    );
  });
  it("rejects shell-quoted, escaped and response-file optimization overrides", () => {
    for (const unsafe of ["-O2 '-O0'", '-O2 "-O0"', "-O2 -\\O0", "-O2 @override.rsp", "-O0 # -O2"])
      expect(runtimeOptimizationProof(ninja(unsafe), rules, library, "/build").optimization).toBe(
        "other",
      );
    for (const unsafe of ["'-O0'", '"-O0"', "-\\O0", "@override.rsp"])
      expect(
        runtimeOptimizationProof(
          ninja("-O2"),
          rules.replace("-c $in", `${unsafe} -c $in`),
          library,
          "/build",
        ).optimization,
      ).toBe("other");
  });
  it("rejects missing rules, objects, wrong output and command-level overrides", () => {
    for (const [build, commands, output] of [
      [ninja("-O2"), "", library],
      [ninja("-O2").replace("runtime.cpp.o\n", "missing.o\n"), rules, library],
      [ninja("-O2"), rules, "/build/wrong.so"],
      [ninja("-O2"), rules.replace("-c $in", "-O0 -c $in"), library],
    ])
      expect(runtimeOptimizationProof(build, commands, output, "/build").optimization).toBe(
        "other",
      );
  });
});
