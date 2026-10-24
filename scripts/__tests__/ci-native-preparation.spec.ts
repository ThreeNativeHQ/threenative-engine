import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { jobSections } from "../ci-workflow.js";

const repo = path.resolve(import.meta.dirname, "../..");
const nativeJobs = new Map(
  jobSections(readFileSync(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8")),
);
const ciJobs = new Map(
  jobSections(readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8")),
);

function stepScript(section: string, name: string): string {
  const step = section.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
  const script = step?.split("        run: |\n")[1];
  if (!script) throw new Error(`Missing executable step: ${name}`);
  return script.replace(/^ {10}/gmu, "");
}

it.each([
  [ciJobs, "test-native"],
  [nativeJobs, "desktop-parity"],
  [nativeJobs, "starter-linux"],
] as const)("changes only the Azure mirror transport in %s %s", (jobs, name) => {
  const script = stepScript(
    jobs.get(name) ?? "",
    "Use the Ubuntu archive mirror for native build dependencies",
  );
  const root = makeTempDirSync("native-apt-mirror-");
  try {
    mkdirSync(path.join(root, "sources.list.d"));
    const suites =
      "Suites: noble noble-updates noble-backports\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
    const sources = {
      "sources.list": "deb http://azure.archive.ubuntu.com/ubuntu noble main universe\n",
      "sources.list.d/ubuntu.sources": `URIs: https://azure.archive.ubuntu.com/ubuntu\n${suites}URIs: http://security.ubuntu.com/ubuntu\n`,
    };
    for (const [file, content] of Object.entries(sources)) {
      writeFileSync(path.join(root, file), content);
    }
    // Redirect only the system file paths; execute the actual workflow's sed command.
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", `sudo() { "$@"; }\n${script.replaceAll("/etc/apt", root)}`],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    for (const [file, original] of Object.entries(sources)) {
      expect(readFileSync(path.join(root, file), "utf8")).toBe(
        original.replace(
          /https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu/gu,
          "https://archive.ubuntu.com/ubuntu",
        ),
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("packs the desktop's existing outputs only after checking their identity", () => {
  const desktop = nativeJobs.get("desktop") ?? "";
  const build = stepScript(desktop, "Build native-smoke workspace dependencies");
  const pack = stepScript(desktop, "Pack the workspace packages for the starter lane");
  expect(build).toContain("--if-present run build");
  expect(build).toContain('test -s "$RUNNER_TEMP/desktop-package-outputs.sha256"');
  expect(pack).not.toContain("--if-present run build");
  expect(pack).toContain("scripts/ios-package-output-snapshot.ts");
  expect(pack.indexOf("cmp -s")).toBeLessThan(pack.indexOf('pnpm --filter "$package_name" pack'));
  expect(pack).toContain("TN_DESKTOP_PACKAGE_OUTPUTS_CHANGED");
  expect(desktop.indexOf("Build native-smoke workspace dependencies")).toBeLessThan(
    desktop.indexOf("native:verify:desktop"),
  );
});

it.each(["Shutdown", "Booted", "missing"])(
  "starts the selected iOS simulator before compilation: %s",
  (state) => {
    const ios = nativeJobs.get("ios-simulator") ?? "";
    const name = "Start the iOS simulator before compiling";
    const script = stepScript(ios, name);
    const root = makeTempDirSync("native-simulator-boot-");
    try {
      const calls = path.join(root, "calls");
      const listing =
        state === "missing"
          ? { devices: {} }
          : {
              devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
                  { name: "iPhone 16", udid: "selected-iphone", state, isAvailable: true },
                ],
              },
            };
      writeFileSync(path.join(root, "listing"), JSON.stringify(listing));
      const xcrun = path.join(root, "xcrun");
      writeFileSync(
        xcrun,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TN_BOOT_CALLS"\nif [ "$2" = list ]; then cat "$TN_BOOT_LISTING"; fi\n',
      );
      chmodSync(xcrun, 0o755);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TN_BOOT_CALLS: calls,
          TN_BOOT_LISTING: path.join(root, "listing"),
        },
        timeout: 5_000,
      });
      expect(result.status === 0, result.stderr).toBe(state !== "missing");
      const commands = readFileSync(calls, "utf8");
      expect(commands.includes("simctl boot selected-iphone")).toBe(state === "Shutdown");
      if (state === "missing") expect(result.stderr).toContain("TN_IOS_SIMULATOR_ABSENT");
      expect(ios.indexOf(`name: ${name}`)).toBeLessThan(
        ios.indexOf("Build iOS proof workspace dependencies"),
      );
      // Completion remains the verifier's responsibility, with all simulator assertions intact.
      expect(ios).toContain("node packages/runtime-native/scripts/verify-ios-simulator.mjs");
      expect(
        readFileSync(
          path.join(repo, "packages/runtime-native/scripts/verify-ios-simulator.mjs"),
          "utf8",
        ),
      ).toContain("'simctl', 'bootstatus', selected.udid, '-b'");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
