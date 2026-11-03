import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const workflow = readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8");

/**
 * A software adapter is a fail-closed error on every target. Hosted CI lanes that cannot avoid one
 * say so at their own seam with the acceptance the CLI already had
 * (`--allow-software` / `TN_PLAYTEST_ALLOW_SOFTWARE=1`), instead of the harness guessing that a
 * native host reporting one has been waved through. Three CI jobs lost their day to the guess, in
 * both directions: once when the target alone decided, once when nothing did.
 */
const DECLARED = /allowSoftwareAdapter: process\.env\.TN_PLAYTEST_ALLOW_SOFTWARE === ['"]1['"]/;

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = workflow.indexOf("\n      - ", start);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

describe("hosted-software acceptance stays declared at the caller", () => {
  it.each([
    "verify-desktop-loading.mjs",
    "verify-desktop-ui-frame.mjs",
    "verify-android-multitouch.mjs",
  ])("%s passes the declared acceptance into the runner config", (script) => {
    const source = readFileSync(path.join(repo, "packages/runtime-native/scripts", script), "utf8");
    expect(source).toMatch(DECLARED);
  });

  it.each([
    ["Build and verify the scaffolded starter", "linux"],
    ["Build and verify the starter's WebView HUD", "windows-matrix"],
    ["Verify the desktop runtime with MSVC", "windows-core"],
    ["Compare the desktop host with browser references", "linux-parity"],
    ["Verify the web UI composites into the game's own frame", "linux-ui-frame"],
    ["Install and play the final signed Windows setup, then uninstall it", "windows-installed"],
  ])("%s declares it on its hosted-software lane", (name) => {
    expect(step(name)).toContain("TN_PLAYTEST_ALLOW_SOFTWARE");
  });

  it("declares it on the SwiftShader emulator lane", () => {
    // The emulator-options block above it is what makes this lane software; the acceptance is set
    // on the same command the conformance runner executes.
    const emulator = workflow.indexOf("-gpu swiftshader_indirect");
    const declared = workflow.indexOf("TN_PLAYTEST_ALLOW_SOFTWARE=1 node");
    expect(emulator).toBeGreaterThan(-1);
    expect(declared).toBeGreaterThan(emulator);
  });

  it("leaves the macOS hardware-default leg undeclared", () => {
    const macOsLeg = workflow.slice(
      // The desktop matrix is the last job to split `native:verify:desktop` across two steps.
      workflow.lastIndexOf("- if: runner.os != 'Windows'"),
      workflow.indexOf("# PRD-217 phases 1/2"),
    );
    expect(macOsLeg).not.toContain("TN_PLAYTEST_ALLOW_SOFTWARE");
  });

  // The starter draws 300 frames at 0.6 to 1.3 s each on the software adapter. 0.3.9 used 271 s of
  // the default 300 s bound, and run 41575190769 was cut at frame 273, so each step that launches
  // it on the Windows leg carries the 600 s bound.
  it.each([
    "Build and verify the starter's WebView HUD",
    "Verify the relocated release container with the installed verifier",
  ])("%s gives the Windows software adapter the 600 s starter bound", (name) => {
    expect(step(name)).toContain(
      "TN_STARTER_TIMEOUT_MS: ${{ matrix.platform == 'Windows' && '600000' || '300000' }}",
    );
  });
});
