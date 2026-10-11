import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

// The C files of the Android lane compile on any host: they use POSIX and dlopen only, and the
// Android-specific calls (mallopt, bionic's key limit) degrade to no-ops elsewhere.
const ANDROID = path.join(import.meta.dirname, "..", "android");
const hasCc = spawnSync("cc", ["--version"]).status === 0;

function scratch() {
  return makeTempDirSync("tn-android-c-");
}

function cc(args: string[]) {
  const run = spawnSync("cc", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`cc ${args.join(" ")}: ${run.stderr}`);
}

describe.runIf(hasCc)("tn_pthread_keys.c", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "pthread_keys_test.c");

  /** The fixture as a shared library, with or without the shim, run by the loader like a Perry library. */
  function run(withShim: boolean, shim = path.join(ANDROID, "tn_pthread_keys.c")) {
    const dir = scratch();
    const library = path.join(dir, "libkeys.so");
    cc([
      "-shared",
      "-fPIC",
      "-Wl,-Bsymbolic",
      "-pthread",
      fixture,
      ...(withShim ? [shim] : []),
      "-o",
      library,
      "-ldl",
    ]);
    const runner = path.join(dir, "runner");
    cc([path.join(ANDROID, "tn_so_runner.c"), "-o", runner, "-ldl", "-pthread"]);
    return spawnSync(runner, [library], { encoding: "utf8" });
  }

  it("hands out more keys than the libc allows and runs every destructor at thread exit", () => {
    const result = run(true);
    expect(result.stdout).toBe("keys ok\n");
    expect(result.status).toBe(0);
  });

  it("red control: a read that ignores the key's generation sees a live thread's stale value", () => {
    const source = fs.readFileSync(path.join(ANDROID, "tn_pthread_keys.c"), "utf8");
    const check =
      "if (table == NULL || table[key].generation != atomic_load(&generations[key])) return NULL;";
    expect(source).toContain(check);
    const broken = path.join(scratch(), "broken_keys.c");
    fs.writeFileSync(broken, source.replace(check, "if (table == NULL) return NULL;"));
    expect(run(true, broken).status).toBe(5);
  });

  it("red control: without the shim the same library cannot create 2000 keys", () => {
    const result = run(false);
    expect(result.stdout).not.toContain("keys ok");
    expect(result.status).toBe(1);
  });
});

describe.runIf(hasCc)("tn_so_runner.c", () => {
  it("runs a library's main, returns its exit code and reports the peak resident set", () => {
    const dir = scratch();
    const library = path.join(dir, "libcase.so");
    const source = path.join(dir, "case.c");
    fs.writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("hello"); return 7; }\n');
    cc(["-shared", "-fPIC", source, "-o", library]);
    const runner = path.join(dir, "runner");
    cc([path.join(ANDROID, "tn_so_runner.c"), "-o", runner, "-ldl"]);

    const run = spawnSync(runner, [library], { encoding: "utf8" });
    expect(run.stdout).toBe("hello\n");
    expect(run.status).toBe(7);
    expect(run.stderr).toMatch(/^TN_PEAK_RSS_KB \d+\n$/u);
  });

  it("fails with its own codes, never a case's, when the library cannot be used", () => {
    const dir = scratch();
    const runner = path.join(dir, "runner");
    cc([path.join(ANDROID, "tn_so_runner.c"), "-o", runner, "-ldl"]);
    expect(spawnSync(runner, [], { encoding: "utf8" }).status).toBe(120);
    const missing = spawnSync(runner, [path.join(dir, "absent.so")], { encoding: "utf8" });
    expect(missing.status).toBe(121);
    expect(missing.stderr).toContain("TN_SO_DLOPEN");
  });
});

it.runIf(hasCc && process.platform === "linux")(
  "Perry's native attribute callbacks carry store keys and scalar lanes",
  () => {
    const dir = scratch();
    const source = path.join(dir, "attribute.c");
    const runtime = path.resolve(ANDROID, "../../../packages/runtime-native");
    fs.writeFileSync(
      source,
      `
#include <assert.h>
#include "${runtime}/src/engine/abi/perry_transport.c"
static int calls;
uint32_t tnp_dispatch(uintptr_t id, uintptr_t data, uint32_t count, uintptr_t packet) {
    const uintptr_t *fields = (const uintptr_t *)packet;
    assert(id == 0 && fields[0] == 9000);
    if (calls++ == 0) {
        assert(data == 8000 && count == 3 && fields[1] == 5);
        return 3;
    }
    assert(data == 0 && count == 0 && fields[1] == 0);
    return 0;
}
int main(void) {
    assert(pull_attribute(9000, 8000, 3, 5) == 3);
    forget_attribute(9000);
    assert(calls == 2);
    return 0;
}
`,
    );
    const binary = path.join(dir, "attribute");
    cc([
      "-ffunction-sections",
      "-Wl,--gc-sections",
      "-I",
      path.join(runtime, "include"),
      source,
      "-o",
      binary,
    ]);
    expect(spawnSync(binary, [], { encoding: "utf8" }).status).toBe(0);
  },
);
