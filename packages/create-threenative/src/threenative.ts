#!/usr/bin/env node
import { build, buildHelp, parseBuildArgs } from "./build.js";
import { type PublicCommand, commandSummaries, threenativeCommands } from "./commands.js";
import {
  type DoctorMode,
  type DoctorTarget,
  diagnoseProject,
  formatDoctorReport,
  readProject,
} from "./doctor.js";
import { fixAuthoringLayer } from "./index.js";

const DOCTOR_TARGETS: readonly DoctorTarget[] = ["web", "desktop", "android", "ios"];
const DOCTOR_MODES: readonly DoctorMode[] = ["debug", "release"];

export function cliHelp(command?: PublicCommand): string {
  if (command === "build") return buildHelp();
  if (command === "doctor") {
    return `${[
      "Usage: threenative doctor [--target web|desktop|android|ios] [--mode debug|release]",
      "                          [--text] [--capture <path>] [--fix [--force]]",
      "",
      "Checks this project against what the build and the native host assume about it:",
      "installed and version-matched @threenative packages, a portable entry that",
      "default-exports a game, a web entry, a scenario that can prove it, and the",
      "capability search an authoring agent needs.",
      "",
      "--target names the build you are about to run, so a prerequisite that build needs",
      "  fails the report instead of describing the target as available with a warning.",
      "  Targets you did not ask for stay in the report but no longer decide the exit code.",
      "--mode debug|release scopes it further; release additionally requires the game's own",
      "  Android signing inputs. Requires --target.",
      "  Release packaging itself is not implemented yet: 'threenative build' has no --mode, and",
      "  the Android packager still assembles debug. --mode release predicts what that build will",
      "  need once PRD-212 ships it, so a green report here is a forecast, not a release.",
      "Prints JSON by default; --text prints the same report for a person.",
      "--capture forwards a browser census JSON or native TN_PIPELINE_EVENT log to the playtest doctor.",
      "--fix rewrites this game's authoring layer (AGENTS.md, CLAUDE.md, skills, hooks, MCP configs)",
      "  from the installed create-threenative, then checks again. To update an existing game:",
      "  'pnpm up --latest create-threenative @threenative/*', then 'pnpm exec threenative doctor --fix'.",
      "  A file this game edited is kept and listed, and the run exits 1 (TN_AUTHORING_LAYER_EDITED);",
      "  --force overwrites it. Git is the undo. .threenative/agent-files.json records what was written.",
      "Exits 0 when nothing failed, 1 when a check failed.",
    ].join("\n")}\n`;
  }
  return `${[
    "Usage: threenative <command> [options]",
    "",
    "Commands:",
    ...threenativeCommands.map((command) => `  ${command.padEnd(6)}  ${commandSummaries[command]}`),
    "",
    "Run 'threenative <command> --help' for command-specific help.",
  ].join("\n")}\n`;
}

function helpFor(argv: readonly string[]): string {
  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return cliHelp();
  if (command === "build") return cliHelp("build");
  if (command === "doctor") return cliHelp("doctor");
  throw new Error(`Unknown threenative command '${command}'.\n${cliHelp()}`);
}

export async function runDoctorCommand(
  argv: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  let capturePath: string | undefined;
  let fix = false;
  let force = false;
  let mode: DoctorMode | undefined;
  let target: DoctorTarget | undefined;
  const valueFor = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--"))
      throw new Error(`doctor: '${flag}' requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--text") continue;
    if (flag === "--fix" || flag === "--force") {
      if (flag === "--fix") fix = true;
      else force = true;
      continue;
    }
    if (flag === "--capture") {
      capturePath = valueFor(flag, argv[index + 1]);
      index += 1;
      continue;
    }
    if (flag === "--target") {
      const value = valueFor(flag, argv[index + 1]);
      if (!DOCTOR_TARGETS.includes(value as DoctorTarget))
        throw new Error(`doctor: '--target' must be one of ${DOCTOR_TARGETS.join(", ")}.`);
      target = value as DoctorTarget;
      index += 1;
      continue;
    }
    if (flag === "--mode") {
      const value = valueFor(flag, argv[index + 1]);
      if (!DOCTOR_MODES.includes(value as DoctorMode))
        throw new Error(`doctor: '--mode' must be one of ${DOCTOR_MODES.join(", ")}.`);
      mode = value as DoctorMode;
      index += 1;
      continue;
    }
    throw new Error(`doctor: unknown option '${String(flag)}'.`);
  }
  // A mode with no target would scope nothing: it says how to build something unnamed.
  if (mode !== undefined && target === undefined)
    throw new Error("doctor: '--mode' requires '--target'.");
  if (force && !fix) throw new Error("doctor: '--force' requires '--fix'.");
  let kept = 0;
  if (fix) {
    const result = await fixAuthoringLayer(cwd, { force });
    const lines = [
      ...result.written.map((file) => `wrote ${file}`),
      ...result.deleted.map((file) => `deleted ${file}`),
      ...result.kept.map((file) => `kept ${file}`),
    ];
    kept = result.kept.length;
    if (kept > 0)
      lines.push(
        `TN_AUTHORING_LAYER_EDITED: kept ${kept} file${kept === 1 ? "" : "s"} this game edited; rerun with --force to overwrite (git is the undo).`,
      );
    process.stderr.write(
      lines.length === 0 ? "authoring layer already current\n" : `${lines.join("\n")}\n`,
    );
  }
  const report = diagnoseProject(await readProject(cwd), { capturePath, mode, target });
  process.stdout.write(
    argv.includes("--text") ? formatDoctorReport(report) : `${JSON.stringify(report, null, 2)}\n`,
  );
  return report.pass && kept === 0 ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpFor(argv));
    return;
  }
  if (argv[0] === "doctor") {
    process.exitCode = await runDoctorCommand(argv.slice(1));
    return;
  }
  await build(parseBuildArgs(argv));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
