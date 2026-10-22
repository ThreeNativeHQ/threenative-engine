import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "xvfb.sh");

/**
 * A PATH containing only the utilities the script itself needs, so a test can decide whether
 * `Xvfb` exists on this machine and what `uname -s` reports. Nothing else leaks in.
 */
function sandbox(unameOutput: string): { bin: string; marker: string } {
  const root = makeTempDirSync("tn-xvfb-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["mktemp", "tr", "sleep", "rm", "cat", "grep", "sh"]) {
    const resolved = spawnSync("command", ["-v", tool], {
      shell: true,
      encoding: "utf8",
    }).stdout.trim();
    if (resolved.length > 0) fs.symlinkSync(resolved, path.join(bin, tool));
  }
  fs.writeFileSync(path.join(bin, "uname"), `#!/bin/sh\necho ${unameOutput}\n`, { mode: 0o755 });
  return { bin, marker: path.join(root, "ran") };
}

function run(bin: string, args: readonly string[]): { status: number; stderr: string } {
  const result = spawnSync("/bin/sh", [SCRIPT, ...args], {
    env: { PATH: bin, HOME: os.tmpdir() },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe("scripts/xvfb.sh", () => {
  it("exits with the wrapped command's own status, which is the whole point of not using xvfb-run", () => {
    const failed = spawnSync("/bin/sh", [SCRIPT, "/bin/sh", "-c", "exit 3"], { encoding: "utf8" });
    expect(failed.status).toBe(3);
    expect(execFileSync("/bin/sh", [SCRIPT, "/bin/true"], { encoding: "utf8" })).toBeDefined();
  });

  it("runs the command directly on a platform that has no Xvfb but has its own display", () => {
    const { bin, marker } = sandbox("Darwin");
    const result = run(bin, ["/bin/sh", "-c", `echo ran > ${marker}; exit 4`]);
    expect(result.stderr).not.toMatch(/not found/i);
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.status).toBe(4);
  });

  it("fails closed on Linux when Xvfb is missing, rather than running the command blind", () => {
    const { bin, marker } = sandbox("Linux");
    const result = run(bin, ["/bin/sh", "-c", `echo ran > ${marker}; exit 0`]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Xvfb/);
  });
});

/**
 * Both copies of the wrapper must hand out a display something can actually composite on. A bare
 * Xvfb has COMPOSITE off and no compositing manager, and the desktop runtime refuses to attach its
 * UI overlay to such a display -- the fix once landed in the packaged copy alone, so the check runs
 * against every copy rather than the one that happened to be edited.
 */
describe.each([
  ["scripts/xvfb.sh", path.join(REPO, "scripts", "xvfb.sh")],
  [
    "packages/runtime-native/scripts/xvfb.sh",
    path.join(REPO, "packages", "runtime-native", "scripts", "xvfb.sh"),
  ],
])("%s composites", (_name, script) => {
  /** A PATH whose `Xvfb` and compositor are recorders, so a test can read what the wrapper ran. */
  function displaySandbox(options: { readonly compositor: boolean }): {
    bin: string;
    xvfbArgs: string;
    compositorArgs: string;
  } {
    const { bin } = sandbox("Linux");
    const xvfbArgs = path.join(bin, "..", "xvfb-args");
    const compositorArgs = path.join(bin, "..", "compositor-args");
    // Reports display :91 on fd 3 the way the real server does, then stays alive to be killed.
    fs.writeFileSync(
      path.join(bin, "Xvfb"),
      `#!/bin/sh\necho "$@" > ${xvfbArgs}\necho 91 >&3\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    if (options.compositor) {
      // Slow on purpose: a real compositor takes a moment to own _NET_WM_CM_S0, and a command
      // that starts first sees a display with no compositing manager.
      fs.writeFileSync(
        path.join(bin, "xcompmgr"),
        `#!/bin/sh\nsleep 0.1\necho "$DISPLAY $@" > ${compositorArgs}\nexec sleep 30\n`,
        { mode: 0o755 },
      );
    }
    // Reports a child on the root once the compositor has started, as the real one does.
    fs.writeFileSync(
      path.join(bin, "xwininfo"),
      `#!/bin/sh\ntest -f ${compositorArgs} && echo "     1 child:"\nexit 0\n`,
      { mode: 0o755 },
    );
    return { bin, xvfbArgs, compositorArgs };
  }

  function runScript(bin: string, args: readonly string[]): { status: number; stderr: string } {
    const result = spawnSync("/bin/sh", [script, ...args], {
      env: { PATH: bin, HOME: os.tmpdir() },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status ?? -1, stderr: result.stderr ?? "" };
  }

  it("enables COMPOSITE and SHAPE and has the compositor up before the command runs", () => {
    const { bin, xvfbArgs, compositorArgs } = displaySandbox({ compositor: true });
    // The command passes only if the compositor reached its display first.
    const started = Date.now();
    const result = runScript(bin, ["/bin/sh", "-c", `test -f ${compositorArgs}`]);
    // A dead xwininfo probe would run out its 5 s bound and still pass; the poll must end on the window.
    expect(Date.now() - started).toBeLessThan(4_000);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(xvfbArgs, "utf8")).toMatch(
      /\+extension COMPOSITE(?=.*\+extension SHAPE)/su,
    );
    // `-n` is plain blending: xcompmgr's shadows and fades would alter the pixels a gate asserts on.
    expect(fs.readFileSync(compositorArgs, "utf8").trim()).toBe(":91 -n");
  });

  it("keeps expected Mesa warnings out of strict headless diagnostics without hiding fatal EGL errors", () => {
    const { bin } = displaySandbox({ compositor: true });
    const result = runScript(bin, ["/bin/sh", "-c", 'test "$EGL_LOG_LEVEL" = fatal']);

    expect(result.status, result.stderr).toBe(0);
  });

  it("still runs the command on a host where no compositor is installed", () => {
    const { bin, compositorArgs } = displaySandbox({ compositor: false });
    const result = runScript(bin, ["/bin/sh", "-c", "exit 7"]);

    expect(result.status).toBe(7);
    expect(fs.existsSync(compositorArgs)).toBe(false);
  });
});

/**
 * Every root script that opens a window must run on a display the operator does not own. The
 * playtest runner provisions its own private Xvfb since the capture-environment change, but these
 * scripts drive Playwright, the visual gate and the conformance runner directly, so the wrapper is
 * what keeps their windows off `:0`. A sweep once painted 63 scenarios onto a working desktop.
 */
describe("root scripts that open windows", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  // Anything that drives a browser, the visual gate, the conformance runner or a native host.
  const OPENS_A_WINDOW =
    /\bplaywright test\b|visual-gate|visual-ab|template-baseline|realism-effects-visual|sweep-capture|run-conformance|verify-template-playtests|verify-golden-path|runner\/cli\.js/u;

  it("runs them under scripts/xvfb.sh", () => {
    const unwrapped = Object.entries(manifest.scripts)
      .filter(([, command]) => OPENS_A_WINDOW.test(command))
      .filter(([, command]) => !command.includes("scripts/xvfb.sh"))
      .map(([name]) => name);
    expect(unwrapped).toEqual([]);
  });

  it("never reaches for xvfb-run, whose exit status is its own failing cleanup kill", () => {
    const offenders = Object.entries(manifest.scripts)
      .filter(([, command]) => /\bxvfb-run\b/u.test(command))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
