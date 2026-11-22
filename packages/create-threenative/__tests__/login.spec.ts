import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { CliExit, authFilePath, login, logout, readToken } from "../src/account.js";

interface IRequestRecord {
  authorization?: string;
  body: Buffer;
  method?: string;
  url?: string;
}

interface IReply {
  body?: unknown;
  status: number;
}

interface IFakeSite {
  close: () => Promise<void>;
  origin: string;
  requests: IRequestRecord[];
}

/** A stand-in for threenative.com on 127.0.0.1, so no test reaches the real site. */
async function fakeSite(handler: (request: IRequestRecord) => IReply): Promise<IFakeSite> {
  const requests: IRequestRecord[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const record = {
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks),
      method: request.method,
      url: request.url,
    };
    requests.push(record);
    const reply = handler(record);
    response.statusCode = reply.status;
    response.setHeader("content-type", "application/json");
    response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    origin: `http://127.0.0.1:${port.toString()}`,
    requests,
  };
}

async function failureOf(run: Promise<unknown>): Promise<CliExit> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CliExit);
  return failure as CliExit;
}

function deviceStart(userCode: string): IReply {
  return {
    body: { deviceCode: `dev-${userCode}`, expiresIn: 900, interval: 1, userCode },
    status: 201,
  };
}

/** The tokens a logout kept for its next run, from the claimed files beside auth.json. */
async function keptTokens(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".logout"));
  return Promise.all(
    names.map(
      async (name) =>
        (JSON.parse(await readFile(path.join(dir, name), "utf8")) as { token: string }).token,
    ),
  );
}

describe("threenative login and logout", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await makeTempDir("tn-auth-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    // A developer machine with a token or a browser must not change what these tests prove.
    vi.stubEnv("THREENATIVE_TOKEN", "");
    vi.stubEnv("THREENATIVE_NO_BROWSER", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("polls the device flow, saves a 0600 token file and names the account", async () => {
    let polls = 0;
    let savedBeforeWhoami: boolean | undefined;
    const site = await fakeSite((request) => {
      if (request.url === "/api/store/device") return deviceStart("ABCD-EFGH");
      if (request.url === "/api/store/device/token") {
        polls += 1;
        return polls < 3
          ? { body: { status: "pending" }, status: 200 }
          : { body: { status: "approved", token: "tok-1" }, status: 200 };
      }
      if (request.url === "/api/store/whoami") {
        // Nothing is saved until the address is known: a logout racing this login can only revoke a
        // token it read from the file, so one write leaves it nothing to bring back.
        savedBeforeWhoami = existsSync(authFilePath());
        return { body: { email: "a@b.c" }, status: 200 };
      }
      return { body: { message: "unexpected request" }, status: 404 };
    });
    const lines: string[] = [];

    await login({
      open: false,
      out: (line) => lines.push(line),
      site: site.origin,
      sleep: async () => {},
    });

    const file = authFilePath();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as { email?: string; token?: string };
    expect(saved).toMatchObject({ email: "a@b.c", token: "tok-1" });
    expect(savedBeforeWhoami).toBe(false);
    // The token was renamed into place from a temp file of its own name: nothing is left beside it.
    expect(await readdir(path.dirname(file))).toEqual(["auth.json"]);
    expect(lines.join("\n")).toContain("/account/device/?code=ABCD-EFGH");
    expect(lines.join("\n")).toContain("Signed in as a@b.c");
    expect(polls).toBe(3);
    expect(site.requests.map(({ method, url }) => `${method ?? ""} ${url ?? ""}`)).toEqual([
      "POST /api/store/device",
      "POST /api/store/device/token",
      "POST /api/store/device/token",
      "POST /api/store/device/token",
      "GET /api/store/whoami",
    ]);
    expect(site.requests.at(-1)?.authorization).toBe("Bearer tok-1");
    await site.close();
  });

  it("saves the granted token and exits 4 when whoami answers an empty 503", async () => {
    const site = await fakeSite((request) => {
      if (request.url === "/api/store/device") return deviceStart("ABCD-EFGH");
      if (request.url === "/api/store/device/token")
        return { body: { status: "approved", token: "tok-1" }, status: 200 };
      return { status: 503 };
    });

    const failure = await failureOf(
      login({ open: false, out: () => {}, site: site.origin, sleep: async () => {} }),
    );

    expect(failure.code).toBe(4);
    expect(JSON.parse(await readFile(authFilePath(), "utf8"))).toEqual({
      site: site.origin,
      token: "tok-1",
    });
    await site.close();
  });

  it("exits 4 when the token poll answers an empty 503", async () => {
    const site = await fakeSite((request) =>
      request.url === "/api/store/device" ? deviceStart("ABCD-EFGH") : { status: 503 },
    );

    const failure = await failureOf(
      login({ open: false, out: () => {}, site: site.origin, sleep: async () => {} }),
    );

    expect(failure.code).toBe(4);
    await site.close();
  });

  it("tightens an existing world-readable token file when signing in again", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-old" }));
    await chmod(file, 0o644);
    const site = await fakeSite((request) => {
      if (request.url === "/api/store/device") return deviceStart("NEW1-CODE");
      if (request.url === "/api/store/device/token")
        return { body: { status: "approved", token: "tok-new" }, status: 200 };
      if (request.url === "/api/store/whoami") return { body: { email: "n@b.c" }, status: 200 };
      return { body: { message: "unexpected request" }, status: 404 };
    });

    await login({ open: false, out: () => {}, site: site.origin, sleep: async () => {} });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      email: "n@b.c",
      token: "tok-new",
    });
    await site.close();
  });

  it("asks you to log in again when the code expired", async () => {
    const site = await fakeSite((request) =>
      request.url === "/api/store/device"
        ? deviceStart("WXYZ-1234")
        : { body: { message: "That code has expired." }, status: 400 },
    );

    const failure = await failureOf(
      login({ open: false, out: () => {}, site: site.origin, sleep: async () => {} }),
    );

    expect(failure.code).toBe(3);
    expect(failure.message).toBe("That code has expired. Run threenative login again.");
    await site.close();
  });

  it("revokes the saved token, never the env one, then deletes the file", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-file" }));
    vi.stubEnv("THREENATIVE_TOKEN", "tok-env");
    const site = await fakeSite(() => ({ body: { ok: true }, status: 200 }));
    const lines: string[] = [];

    await logout({ out: (line) => lines.push(line), site: site.origin });

    expect(site.requests).toHaveLength(1);
    expect(site.requests[0]).toMatchObject({
      authorization: "Bearer tok-file",
      method: "DELETE",
      url: "/api/store/token",
    });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(lines).toEqual(["Signed out."]);
    await site.close();
  });

  it("keeps a token a login saved while logout was revoking the old one", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-old" }));
    // A login in another terminal finishes while the revoke is in flight.
    const site = await fakeSite(() => {
      writeFileSync(file, JSON.stringify({ token: "tok-new" }));
      return { body: { ok: true }, status: 200 };
    });

    await logout({ out: () => {}, site: site.origin });

    expect(site.requests[0]?.authorization).toBe("Bearer tok-old");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: "tok-new" });
    await site.close();
  });

  it("keeps the token file when the server refuses the revoke", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-file" }));
    const site = await fakeSite(() => ({ body: { message: "Server exploded." }, status: 500 }));
    const lines: string[] = [];

    const failure = await failureOf(logout({ out: (line) => lines.push(line), site: site.origin }));

    expect(failure.code).toBe(4);
    expect(failure.message).toBe(
      "Could not revoke the token (500). The token is kept, so run threenative logout again.",
    );
    expect(await keptTokens(file)).toEqual(["tok-file"]);
    expect(lines).toEqual([]);
    await site.close();

    // The next logout finds the kept token and revokes it.
    const retry = await fakeSite(() => ({ body: { ok: true }, status: 200 }));
    await logout({ out: (line) => lines.push(line), site: retry.origin });
    expect(retry.requests[0]?.authorization).toBe("Bearer tok-file");
    expect(await readdir(path.dirname(file))).toEqual([]);
    expect(lines).toEqual(["Signed out."]);
    await retry.close();
  });

  it("revokes a token on the site that issued it, whatever THREENATIVE_SITE says now", async () => {
    const issuer = await fakeSite(() => ({ body: { ok: true }, status: 200 }));
    const other = await fakeSite(() => ({ body: { ok: true }, status: 401 }));
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ site: issuer.origin, token: "tok-prod" }));

    await logout({ out: () => {}, site: other.origin });

    expect(issuer.requests.map((request) => request.authorization)).toEqual(["Bearer tok-prod"]);
    expect(other.requests).toEqual([]);
    await issuer.close();
    await other.close();
  });

  it.skipIf(process.getuid?.() === 0)("keeps a token file it cannot read", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-locked" }), { mode: 0o000 });
    const site = await fakeSite(() => ({ body: { ok: true }, status: 200 }));

    const failure = await failureOf(logout({ out: () => {}, site: site.origin }));

    expect(failure.code).toBe(4);
    expect(failure.message).toContain("The token is kept, so run threenative logout again.");
    expect(site.requests).toEqual([]);
    const left = (await readdir(path.dirname(file))).filter((name) => name.endsWith(".logout"));
    expect(left).toHaveLength(1);
    await site.close();
  });

  it("revokes a token an interrupted logout left behind", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    // Ctrl+C after the claim, before the revoke: no auth.json, only the claimed file.
    await writeFile(`${file}.left.logout`, JSON.stringify({ token: "tok-left" }));
    const site = await fakeSite(() => ({ body: { ok: true }, status: 200 }));

    await logout({ out: () => {}, site: site.origin });

    expect(site.requests.map((request) => request.authorization)).toEqual(["Bearer tok-left"]);
    expect(await readdir(path.dirname(file))).toEqual([]);
    await site.close();
  });

  it("keeps the token file when the site is unreachable", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-file" }));
    const site = await fakeSite(() => ({ body: {}, status: 200 }));
    const origin = site.origin;
    await site.close();

    const failure = await failureOf(logout({ out: () => {}, site: origin }));

    expect(failure.code).toBe(5);
    expect(failure.message).toContain(`Could not reach ${origin}`);
    expect(failure.message).toContain("The token is kept, so run threenative logout again.");
    expect(await keptTokens(file)).toEqual(["tok-file"]);
  });

  it("prefers THREENATIVE_TOKEN over the saved file", async () => {
    const file = authFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ token: "tok-file" }));
    expect(await readToken()).toBe("tok-file");

    vi.stubEnv("THREENATIVE_TOKEN", "tok-env");
    expect(await readToken()).toBe("tok-env");
  });

  it("reports a closed port as a network failure", async () => {
    const site = await fakeSite(() => ({ body: {}, status: 200 }));
    const origin = site.origin;
    await site.close();

    const failure = await failureOf(
      login({ open: false, out: () => {}, site: origin, sleep: async () => {} }),
    );

    expect(failure.code).toBe(5);
    expect(failure.message).toContain(`Could not reach ${origin}`);
  });
});
