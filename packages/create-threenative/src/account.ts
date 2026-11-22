/** `threenative login` and `threenative logout`: the device-code flow against threenative.com,
 * and the one token file every command that talks to a server reads.
 *
 * Exit codes are shared by login, logout and deploy: 0 ok, 2 bad arguments, 3 sign in again,
 * 4 refused by the server, 5 network failure. `main()` prints the message and sets the code. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class CliExit extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "CliExit";
    this.code = code;
  }
}

const DEFAULT_SITE = "https://threenative.com";

export function siteOrigin(site = process.env.THREENATIVE_SITE): string {
  return (site ?? DEFAULT_SITE).replace(/\/+$/u, "");
}

function configHome(env: NodeJS.ProcessEnv): string {
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "") return env.XDG_CONFIG_HOME;
  // `~/.config` on macOS too, as `gh` and `wrangler` do; Windows keeps its roaming config folder.
  if (process.platform === "win32") return env.APPDATA ?? homedir();
  return path.join(homedir(), ".config");
}

/** `$XDG_CONFIG_HOME/threenative/auth.json`, default `~/.config` (`%APPDATA%` on Windows). */
export function authFilePath(env = process.env): string {
  return path.join(configHome(env), "threenative", "auth.json");
}

export interface IAuthFile {
  email?: string;
  token?: string;
}

async function readAuthFile(env: NodeJS.ProcessEnv): Promise<IAuthFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authFilePath(env), "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as IAuthFile) : undefined;
  } catch {
    // No file, or one a person half-edited: either way this machine has no saved token.
    return undefined;
  }
}

/** `THREENATIVE_TOKEN` wins for one command, so CI can publish without a config file. */
export async function readToken(env = process.env): Promise<string | undefined> {
  const fromEnv = env.THREENATIVE_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const file = await readAuthFile(env);
  return typeof file?.token === "string" && file.token !== "" ? file.token : undefined;
}

export async function requireToken(): Promise<string> {
  const token = await readToken();
  if (token === undefined) throw new CliExit(3, "Not signed in. Run threenative login.");
  return token;
}

export interface IReply {
  body: unknown;
  status: number;
  statusText: string;
}

/** One JSON request. A broken connection is the only thing exit code 5 means, so it is caught
 * here: both a fetch that never connected and a body that dies after the headers arrived. */
export async function request(
  origin: string,
  pathname: string,
  init: RequestInit = {},
): Promise<IReply> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${origin}${pathname}`, init);
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliExit(5, `Could not reach ${origin}: ${reason}`);
  }
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    // A non-JSON body (a proxy page) is still worth surfacing as text, which it already is.
  }
  return { body, status: response.status, statusText: response.statusText };
}

/** Site errors are `{ error: "TN_…", message: "…" }`; a person reads the message, not the code. */
export function serverMessage(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message !== "" ? message : fallback;
}

function numberField(body: unknown, key: string): number | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonPost(value: unknown): RequestInit {
  return {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  };
}

async function writeAuthFile(auth: IAuthFile): Promise<void> {
  const file = authFilePath();
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  // Create the token 0600 beside the real file and rename it over: a rename replaces the
  // destination atomically, so no window leaves the new token in a world-readable inode. The
  // temp name is unique per write, so two logins sharing one config directory never share it.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function openBrowser(link: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", link] : [link];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // A machine with no browser (a container, CI) must not fail the login it is polling through.
    child.on("error", () => {});
    child.unref();
  } catch {
    // spawn throws only on bad arguments; a missing binary arrives as the 'error' event above.
  }
}

export interface ILoginOptions {
  open?: boolean;
  out?: (line: string) => void;
  site?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Device-code sign-in: print the code, poll until the browser authorizes, save the token. */
export async function login(options: ILoginOptions = {}): Promise<void> {
  const origin = siteOrigin(options.site);
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));

  const start = await request(origin, "/api/store/device", jsonPost({}));
  if (start.status !== 201)
    throw new CliExit(4, serverMessage(start.body, `Sign in failed (${start.status}).`));
  const deviceCode = (start.body as { deviceCode?: unknown }).deviceCode;
  const userCode = (start.body as { userCode?: unknown }).userCode;
  if (typeof deviceCode !== "string" || deviceCode === "")
    throw new CliExit(4, "The sign-in server sent no device code.");
  const link = `${origin}/account/device/?code=${encodeURIComponent(typeof userCode === "string" ? userCode : "")}`;
  out(`Open ${link} and click Authorize.`);
  out(`Code: ${typeof userCode === "string" ? userCode : ""}`);
  if (options.open !== false && process.env.THREENATIVE_NO_BROWSER !== "1") openBrowser(link);

  const expiresAt = Date.now() + (numberField(start.body, "expiresIn") ?? 900) * 1_000;
  let interval = numberField(start.body, "interval") ?? 5;
  const pollForToken = async (): Promise<string> => {
    for (;;) {
      await sleep(interval * 1_000);
      if (Date.now() >= expiresAt)
        throw new CliExit(3, "The code expired. Run threenative login again.");
      const reply = await request(origin, "/api/store/device/token", jsonPost({ deviceCode }));
      const status = (reply.body as { status?: unknown }).status;
      if (reply.status >= 400 && reply.status < 500)
        throw new CliExit(
          3,
          `${serverMessage(reply.body, "Sign in was refused.")} Run threenative login again.`,
        );
      if (reply.status < 200 || reply.status >= 300)
        throw new CliExit(4, serverMessage(reply.body, `Sign in failed (${reply.status}).`));
      const nextInterval = numberField(reply.body, "interval");
      if (nextInterval !== undefined && nextInterval > 0) interval = nextInterval;
      if (status !== "approved") continue;
      const token = (reply.body as { token?: unknown }).token;
      if (typeof token !== "string" || token === "")
        throw new CliExit(4, "The sign-in server approved without a token.");
      return token;
    }
  };

  const token = await pollForToken();
  // Save before asking who this is: a whoami hiccup must not throw away a granted token.
  await writeAuthFile({ token });
  const who = await request(origin, "/api/store/whoami", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (who.status < 200 || who.status >= 300)
    throw new CliExit(4, serverMessage(who.body, `Could not read your account (${who.status}).`));
  const email = (who.body as { email?: unknown }).email;
  const address = typeof email === "string" ? email : "";
  await writeAuthFile({ email: address, token });
  out(`Signed in as ${address}.`);
}

export interface ILogoutOptions {
  out?: (line: string) => void;
  site?: string;
}

/** Revoke the saved token and delete the file. `THREENATIVE_TOKEN` is not touched.
 *
 * The file goes only when the server answered 200 or 401 (401 means the token is already dead,
 * so this machine is signed out either way). Any other answer, or a network failure from
 * `request()`, leaves the token saved: a token still alive on the server must not be dropped
 * from this machine, or `logout` could never revoke it again. */
export async function logout(options: ILogoutOptions = {}): Promise<void> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = process.env;
  const token = (await readAuthFile(env))?.token;
  if (typeof token !== "string" || token === "") {
    out("Not signed in.");
    return;
  }
  const origin = siteOrigin(options.site);
  const reply = await request(origin, "/api/store/token", {
    headers: { authorization: `Bearer ${token}` },
    method: "DELETE",
  });
  if (reply.status !== 200 && reply.status !== 401)
    throw new CliExit(
      4,
      `Could not revoke the token (${reply.status}). It is still saved; run threenative logout again.`,
    );
  // A login in another terminal may have saved a new token while this one was being revoked: that
  // token is live and is not the one signed out, so only the file still holding the revoked one goes.
  // ponytail: re-read then delete, a window of microseconds; a lock file if two terminals ever race it.
  if ((await readAuthFile(env))?.token === token) await rm(authFilePath(env), { force: true });
  out("Signed out.");
}
