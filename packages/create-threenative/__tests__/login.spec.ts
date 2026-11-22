import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
    const site = await fakeSite((request) => {
      if (request.url === "/api/store/device") return deviceStart("ABCD-EFGH");
      if (request.url === "/api/store/device/token") {
        polls += 1;
        return polls < 3
          ? { body: { status: "pending" }, status: 200 }
          : { body: { status: "approved", token: "tok-1" }, status: 200 };
      }
      if (request.url === "/api/store/whoami") return { body: { email: "a@b.c" }, status: 200 };
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
