/** The complete `threenative` command surface, in one place so the help text, the dispatcher and
 * the documentation checks cannot disagree. Adding a command means adding it here and teaching
 * `threenative.ts` to run it. */
export type PublicCommand = "build" | "doctor" | "login" | "logout" | "deploy";

export const threenativeCommands: readonly PublicCommand[] = [
  "build",
  "doctor",
  "deploy",
  "login",
  "logout",
];

export const commandSummaries: Record<PublicCommand, string> = {
  build: "Build web or native output.",
  doctor: "Check this project and report what would break a build.",
  deploy: "Build for the web and publish the game to its share link on threenative.com.",
  login: "Sign in to your threenative.com account.",
  logout: "Sign out and revoke this machine's token.",
};
