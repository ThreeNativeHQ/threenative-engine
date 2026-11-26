// Machine-local sharing consent (PRD-918). It lives in the developer's own config directory, never
// in a project: cloning a repository can never opt another developer into uploading anything.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ITelemetryPrefs {
  /** Share self-contained procedural `.glb` bakes with the community library. Default off. */
  readonly shareProcedurals: boolean;
  /** Share scrubbed AI session traces to train Inkling Mini 2. Default off. */
  readonly shareSessionTraces: boolean;
}

export const DEFAULT_PREFS: ITelemetryPrefs = {
  shareProcedurals: false,
  shareSessionTraces: false,
};

/** `$XDG_CONFIG_HOME/threenative`, else `~/.config/threenative` (Windows: `%APPDATA%`). */
export function prefsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === "win32" && env.APPDATA) ||
    path.join(os.homedir(), ".config");
  return path.join(base, "threenative");
}

export const prefsFile = (env?: NodeJS.ProcessEnv): string =>
  path.join(prefsDir(env), "telemetry.json");

/** The saved consent; a missing or unreadable file means every switch is off. */
export async function readPrefs(env?: NodeJS.ProcessEnv): Promise<ITelemetryPrefs> {
  try {
    const raw = JSON.parse(await readFile(prefsFile(env), "utf8")) as Record<string, unknown>;
    return {
      shareProcedurals: raw.shareProcedurals === true,
      shareSessionTraces: raw.shareSessionTraces === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Writes only booleans for the two known keys; anything else in `patch` throws. */
export async function writePrefs(
  patch: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
): Promise<ITelemetryPrefs> {
  for (const [key, value] of Object.entries(patch))
    if (!(key in DEFAULT_PREFS) || typeof value !== "boolean")
      throw new Error(`${key}: expected a boolean sharing switch`);
  const next = { ...(await readPrefs(env)), ...patch } as ITelemetryPrefs;
  const file = prefsFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return next;
}
