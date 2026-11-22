/** `threenative login` and `threenative logout`: the device-code flow against threenative.com,
 * and the one token file every command that talks to a server reads.
 *
 * Exit codes are shared by login, logout and deploy: 0 ok, 2 bad arguments, 3 sign in again,
 * 4 refused by the server, 5 network failure. `main()` prints the message and sets the code. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  /** The site that issued the token: logout revokes it there, whatever `THREENATIVE_SITE` says now. */
  site?: string;
  token?: string;
}

async function readAuthFile(
  env: NodeJS.ProcessEnv,
  file = authFilePath(env),
): Promise<IAuthFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
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
  const deviceCode = (start.body as { deviceCode?: unknown } | null | undefined)?.deviceCode;
  const userCode = (start.body as { userCode?: unknown } | null | undefined)?.userCode;
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
      const status = (reply.body as { status?: unknown } | null | undefined)?.status;
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
      const token = (reply.body as { token?: unknown } | null | undefined)?.token;
      if (typeof token !== "string" || token === "")
        throw new CliExit(4, "The sign-in server approved without a token.");
      return token;
    }
  };

  const token = await pollForToken();
  out(`Signed in as ${await saveSignIn(origin, token)}.`);
}

/** Saves a granted token with the address it belongs to, and returns that address. */
async function saveSignIn(origin: string, token: string): Promise<string> {
  // One write, after asking who this is: a logout in another terminal can only revoke a token it
  // read from the file, so a second write could bring back a token that logout already revoked.
  // A whoami hiccup still saves the granted token, without the address, before it reports.
  let who: Awaited<ReturnType<typeof request>>;
  try {
    who = await request(origin, "/api/store/whoami", {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    await writeAuthFile({ site: origin, token });
    throw error;
  }
  const email = (who.body as { email?: unknown } | null | undefined)?.email;
  const address = typeof email === "string" ? email : "";
  await writeAuthFile(
    address === "" ? { site: origin, token } : { email: address, site: origin, token },
  );
  if (who.status < 200 || who.status >= 300)
    throw new CliExit(4, serverMessage(who.body, `Could not read your account (${who.status}).`));
  return address;
}

export interface ILogoutOptions {
  out?: (line: string) => void;
  site?: string;
}

/** Revoke the saved token and delete the file. `THREENATIVE_TOKEN` is not touched.
 *
 * Each token file is claimed with one rename before its revoke, so a login in another terminal that
 * saves meanwhile writes a new auth.json this logout never touches. A token the server did not
 * revoke (any answer but 200 or 401, or no answer) stays in its claimed `auth.json.<id>.logout` file,
 * and so does one whose logout was interrupted: every logout claims those leftovers too and revokes
 * them, so a live token is never dropped from this machine while nothing can revoke it. */
export async function logout(options: ILogoutOptions = {}): Promise<void> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = process.env;
  const claims = await claimTokenFiles(authFilePath(env));
  let revoked = false;
  let failure: CliExit | undefined;
  for (const claimed of claims) {
    const auth = await readClaim(claimed);
    if (auth instanceof CliExit) {
      failure = auth;
      continue;
    }
    const token = auth?.token;
    if (typeof token !== "string" || token === "") {
      await rm(claimed, { force: true });
      continue;
    }
    // Revoked where it was issued: a token from one site sent to another would only earn a 401 there,
    // which reads as "already dead" and would drop a token still live on its own site.
    const origin =
      typeof auth?.site === "string" && auth.site !== "" ? auth.site : siteOrigin(options.site);
    const answer = await revokeToken(origin, token);
    if (answer === undefined) {
      await rm(claimed, { force: true });
      revoked = true;
    } else failure = answer;
  }
  if (failure !== undefined) throw failure;
  out(revoked ? "Signed out." : "Not signed in.");
}

/** A claimed token file's contents. A file that cannot be read is kept, so a live token is never
 * deleted unrevoked; one that is not JSON holds no token and is `undefined`, like no file at all. */
async function readClaim(claimed: string): Promise<IAuthFile | undefined | CliExit> {
  let text: string;
  try {
    text = await readFile(claimed, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return new CliExit(
      4,
      `Could not read ${claimed} (${code}). The token is kept, so run threenative logout again.`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as IAuthFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Claims auth.json and every token file an earlier logout left, each with one rename to a name of
 * this run's own: two logouts never revoke from, or delete, one file. */
async function claimTokenFiles(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  // A directory this user cannot list can still hold an auth.json it can rename by name, so a failed
  // listing only skips the leftovers; it never reads as "not signed in".
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    // No directory: the rename below finds no auth.json either.
  }
  const left = names.filter((name) => name.startsWith(`${base}.`) && name.endsWith(".logout"));
  const claims: string[] = [];
  for (const source of [file, ...left.map((name) => path.join(dir, name))]) {
    const claimed = `${file}.${randomUUID()}.logout`;
    try {
      await rename(source, claimed);
      claims.push(claimed);
    } catch (error) {
      // Gone already: never saved, or another logout claimed it first.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return claims;
}

/** `undefined` once the site says the token is dead (200 revoked, 401 already gone), else why not. */
async function revokeToken(origin: string, token: string): Promise<CliExit | undefined> {
  const kept = "The token is kept, so run threenative logout again.";
  try {
    const reply = await request(origin, "/api/store/token", {
      headers: { authorization: `Bearer ${token}` },
      method: "DELETE",
    });
    if (reply.status === 200 || reply.status === 401) return undefined;
    return new CliExit(4, `Could not revoke the token (${reply.status}). ${kept}`);
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    return new CliExit(error.code, `${error.message} ${kept}`);
  }
}
