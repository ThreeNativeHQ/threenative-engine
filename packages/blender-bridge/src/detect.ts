import { execFileSync } from "node:child_process";
import { accessSync, existsSync, constants as fsConstants, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";

/**
 * Finds the Blender this machine already has. It never installs one, never downloads one, and
 * never throws.
 *
 * Blender is GPLv2-or-later and roughly 350 MB. This package resolves the binary and drives it as
 * a separate process; it links nothing, vendors nothing, and bundles nothing. `npm install`
 * therefore costs zero Blender bytes, and a machine without Blender gets a result that names the
 * install command for its platform rather than an exception a host would show as a dead server.
 */

export type BlenderCause = "blender-missing" | "blender-too-old" | "blender-unreadable";

export interface IBlenderInstallGuidance {
  readonly linux: string;
  readonly macos: string;
  readonly windows: string;
}

export interface IBlenderStatus {
  readonly available: boolean;
  /** Absent when `available`; otherwise the named reason, never a bare failure. */
  readonly cause?: BlenderCause;
  readonly detail: string;
  readonly install: IBlenderInstallGuidance;
  readonly minimumVersion: string;
  /** Present whenever a binary was found, including one that turned out to be too old. */
  readonly path?: string;
  readonly version?: string;
}

/** The oldest Blender whose glTF 2.0 exporter this package's scripts are written against. */
export const BLENDER_VERSION_FLOOR = Object.freeze({ major: 4, minor: 2 });

export const BLENDER_INSTALL_GUIDANCE: IBlenderInstallGuidance = Object.freeze({
  linux:
    "sudo snap install blender --classic   (or your distribution's package, or https://www.blender.org/download/)",
  macos: "brew install --cask blender   (or https://www.blender.org/download/)",
  windows: "winget install --id BlenderFoundation.Blender   (or https://www.blender.org/download/)",
});

function floorString(): string {
  return `${BLENDER_VERSION_FLOOR.major}.${BLENDER_VERSION_FLOOR.minor}`;
}

/** The platform's own line, so a message names one command rather than three. */
export function installCommandFor(platformName: string = osPlatform()): string {
  if (platformName === "darwin") return BLENDER_INSTALL_GUIDANCE.macos;
  if (platformName === "win32") return BLENDER_INSTALL_GUIDANCE.windows;
  return BLENDER_INSTALL_GUIDANCE.linux;
}

function executableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(platformName: string): readonly string[] {
  return platformName === "win32" ? ["blender.exe", "blender.com"] : ["blender"];
}

function pathCandidates(environment: NodeJS.ProcessEnv, platformName: string): readonly string[] {
  const raw = environment.PATH ?? environment.Path ?? "";
  if (raw.trim().length === 0) return [];
  return raw
    .split(path.delimiter)
    .filter((directory) => directory.trim().length > 0)
    .flatMap((directory) => binaryNames(platformName).map((name) => path.join(directory, name)));
}

/** Where each platform's installer puts Blender when it is not on `PATH` — a macOS `.app` never is. */
function conventionalCandidates(platformName: string, home: string): readonly string[] {
  if (platformName === "darwin") {
    return [
      "/Applications/Blender.app/Contents/MacOS/Blender",
      path.join(home, "Applications/Blender.app/Contents/MacOS/Blender"),
    ];
  }
  if (platformName === "win32") {
    const roots = [
      process.env.ProgramFiles ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ];
    return roots.flatMap((root) =>
      ["5.2", "5.1", "5.0", "4.5", "4.2"].map((release) =>
        path.join(root, "Blender Foundation", `Blender ${release}`, "blender.exe"),
      ),
    );
  }
  return [
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/var/lib/flatpak/exports/bin/org.blender.Blender",
    path.join(home, ".local/bin/blender"),
  ];
}

/** `blender --version` prints `Blender X.Y.Z` on its first line, then a build banner. */
export function parseBlenderVersion(output: string): string | undefined {
  const match = /^Blender\s+(\d+\.\d+(?:\.\d+)?)/mu.exec(output);
  return match?.[1];
}

function compareToFloor(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(major) || Number.isNaN(minor)) return false;
  if (major !== BLENDER_VERSION_FLOOR.major) return major > BLENDER_VERSION_FLOOR.major;
  return minor >= BLENDER_VERSION_FLOOR.minor;
}

export type VersionProbe = (binary: string) => string | undefined;

/** Runs the binary once. A binary that hangs, crashes or prints nothing readable is not a Blender. */
export const probeBlenderVersion: VersionProbe = (binary) => {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return parseBlenderVersion(output);
  } catch {
    return undefined;
  }
};

export interface IResolveBlenderOptions {
  readonly home?: string;
  readonly platform?: string;
  readonly probeVersion?: VersionProbe;
}

/**
 * `THREENATIVE_BLENDER_PATH`, then `PATH`, then the platform's conventional install locations —
 * the same order PRD-295 set for FabCLI, so one vocabulary covers every external executable this
 * framework drives.
 *
 * An explicit `THREENATIVE_BLENDER_PATH` that does not resolve is reported as its own cause: a
 * user who set that variable wants to know it is wrong, not to be told Blender is missing while a
 * different Blender on `PATH` is quietly used instead.
 */
export function resolveBlender(
  environment: NodeJS.ProcessEnv = process.env,
  options: IResolveBlenderOptions = {},
): IBlenderStatus {
  const platformName = options.platform ?? osPlatform();
  // The caller's environment describes the machine, and that includes where "home" is. Reading the
  // real `homedir()` while honouring the caller's `PATH` was a half-override: a scrubbed
  // environment still resolved `~/.local/bin/blender` and reported Blender present.
  const home = options.home ?? environment.HOME ?? environment.USERPROFILE ?? homedir();
  const probeVersion = options.probeVersion ?? probeBlenderVersion;
  const minimumVersion = floorString();
  const install = BLENDER_INSTALL_GUIDANCE;

  const override = environment.THREENATIVE_BLENDER_PATH;
  if (override !== undefined && override.trim().length > 0) {
    const candidate = path.resolve(override.trim());
    if (!executableFile(candidate)) {
      return {
        available: false,
        cause: "blender-unreadable",
        detail: `THREENATIVE_BLENDER_PATH points at '${candidate}', which is not an executable file.`,
        install,
        minimumVersion,
        path: candidate,
      };
    }
    return classify(candidate, probeVersion, minimumVersion, install);
  }

  const candidates = [
    ...pathCandidates(environment, platformName),
    ...conventionalCandidates(platformName, home),
  ];
  for (const candidate of candidates) {
    if (!executableFile(candidate)) continue;
    const classified = classify(candidate, probeVersion, minimumVersion, install);
    // Keep walking past a binary that is not a Blender at all; stop at one that is, even when it
    // is too old, so the report names the version the user has rather than claiming none exists.
    if (classified.cause !== "blender-unreadable") return classified;
  }
  return {
    available: false,
    cause: "blender-missing",
    detail: `No Blender ${minimumVersion} or newer was found. Set THREENATIVE_BLENDER_PATH, or install it: ${installCommandFor(platformName)}`,
    install,
    minimumVersion,
  };
}

function classify(
  binary: string,
  probeVersion: VersionProbe,
  minimumVersion: string,
  install: IBlenderInstallGuidance,
): IBlenderStatus {
  const version = probeVersion(binary);
  if (version === undefined) {
    return {
      available: false,
      cause: "blender-unreadable",
      detail: `'${binary}' did not report a Blender version.`,
      install,
      minimumVersion,
      path: binary,
    };
  }
  if (!compareToFloor(version)) {
    return {
      available: false,
      cause: "blender-too-old",
      detail: `Blender ${version} at '${binary}' is older than the supported floor ${minimumVersion}.`,
      install,
      minimumVersion,
      path: binary,
      version,
    };
  }
  return {
    available: true,
    detail: `Blender ${version} at '${binary}'.`,
    install,
    minimumVersion,
    path: binary,
    version,
  };
}
