/** The complete `threenative` command surface, in one place so the help text, the dispatcher and
 * the documentation checks cannot disagree. Adding a command means adding it here and teaching
 * `threenative.ts` to run it. */
export type PublicCommand = "build" | "doctor";

export const threenativeCommands: readonly PublicCommand[] = ["build", "doctor"];

export const commandSummaries: Record<PublicCommand, string> = {
  build: "Build web or native output.",
  doctor: "Check this project and report what would break a build.",
};
