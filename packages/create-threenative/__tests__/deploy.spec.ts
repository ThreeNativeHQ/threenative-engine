import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { CliExit } from "../src/account.js";
import { deploy, packDirectory } from "../src/deploy.js";

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

interface IFakeStudio {
  close: () => Promise<void>;
  origin: string;
  requests: IRequestRecord[];
}

/** A stand-in for studio.threenative.com on 127.0.0.1, so no test reaches the real Studio. */
async function fakeStudio(
  handler: (request: IRequestRecord) => IReply | Promise<IReply>,
): Promise<IFakeStudio> {
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
    const reply = await handler(record);
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

/** Studio's parser, written from the wire format rather than from packDirectory's code. */
function decode(archive: Buffer): { content: string; name: string }[] {
  const entries: { content: string; name: string }[] = [];
  let offset = 0;
  while (offset < archive.length) {
    const nameLength = archive.readUInt32BE(offset);
    offset += 4;
    const name = archive.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const size = archive.readUInt32BE(offset);
    offset += 4;
    const content = archive.subarray(offset, offset + size).toString("utf8");
    offset += size;
    entries.push({ content, name });
  }
  return entries;
}

function entry(archive: Buffer, name: string): string | undefined {
  return decode(archive).find((candidate) => candidate.name === name)?.content;
}

async function projectDir(scripts: Record<string, string>): Promise<string> {
  const cwd = await makeTempDir("tn-deploy-");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "game", scripts }));
  return cwd;
}

async function writeBuild(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, "dist"), { recursive: true });
  await writeFile(path.join(cwd, "dist", "index.html"), "<p>hi</p>");
}

interface IShareSnapshot {
  deployKey?: string;
  projectId?: string;
}

/** What `.threenative/share.json` held at this instant, read from inside a fake Studio handler. */
async function readShareFile(cwd: string): Promise<IShareSnapshot | undefined> {
  try {
    const text = await readFile(path.join(cwd, ".threenative", "share.json"), "utf8");
    return JSON.parse(text) as IShareSnapshot;
  } catch {
    return undefined;
  }
}

function queryOf(url: string | undefined): URLSearchParams {
  return new URLSearchParams((url ?? "").split("?")[1] ?? "");
}

async function failureOf(run: Promise<unknown>): Promise<CliExit> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CliExit);
  return failure as CliExit;
}

describe("threenative deploy", () => {
  it("packs files in Studio's byte layout and drops a compressed sibling", async () => {
    const root = await makeTempDir("tn-pack-");
    await writeFile(path.join(root, "index.html"), "<p>hi</p>");
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "a", "b.js"), "console.log(1);");
    await writeFile(path.join(root, "a", "b.js.br"), "BROTLI");
    // Kept: the original `c` is absent, so the only copy of it is this gzip.
    await writeFile(path.join(root, "c.gz"), "GZIP");

    const entries = decode(await packDirectory(root));

    expect(entries.map(({ content, name }) => `${name}=${content}`).sort()).toEqual([
      "a/b.js=console.log(1);",
      "c.gz=GZIP",
      "index.html=<p>hi</p>",
    ]);
    expect(entries.some(({ name }) => name === "a/b.js.br")).toBe(false);
  });

  it("keys the first deploy and keeps the same link on the next deploy", async () => {
    const cwd = await projectDir({ "build:web": "vite build" });
    // What share.json held as each upload arrived: the key has to be written before the upload,
    // or a reply lost on the way back would leave the retry with nothing to name the game by.
    const shareAtRequest: (IShareSnapshot | undefined)[] = [];
    const site = await fakeStudio(async () => {
      shareAtRequest.push(await readShareFile(cwd));
      return { body: { projectId: "p1", shareUrl: "https://x-share.example/" }, status: 200 };
    });
    const lines: string[] = [];
    const options = {
      cwd,
      out: (line: string) => lines.push(line),
      runBuild: writeBuild,
      studio: site.origin,
      token: "tok-1",
    };

    const first = await deploy(options);

    expect(first).toEqual({ projectId: "p1", shareUrl: "https://x-share.example/" });
    expect(site.requests[0]).toMatchObject({
      authorization: "Bearer tok-1",
      method: "PUT",
    });
    const firstQuery = queryOf(site.requests[0]?.url);
    const deployKey = firstQuery.get("key");
    expect(deployKey).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u);
    expect(firstQuery.get("name")).toBe("game");
    expect(firstQuery.has("projectId")).toBe(false);
    // Written before the request arrived, and the same key the request carried.
    expect(shareAtRequest[0]).toEqual({ deployKey });
    expect(entry(site.requests[0]?.body ?? Buffer.alloc(0), "index.html")).toBe("<p>hi</p>");
    // The link alone on the last stdout line: an agent parses that line, not the prose above it.
    expect(lines.at(-1)).toBe("https://x-share.example/");
    expect(await readShareFile(cwd)).toEqual({ deployKey, projectId: "p1" });

    const second = await deploy(options);

    expect(site.requests[1]?.url).toBe("/api/cli/share?name=game&projectId=p1");
    expect(queryOf(site.requests[1]?.url).has("key")).toBe(false);
    expect(shareAtRequest[1]).toEqual({ deployKey, projectId: "p1" });
    expect(second).toEqual(first);
    expect(await readShareFile(cwd)).toEqual({ deployKey, projectId: "p1" });
    // Written through a temp file and renamed: nothing but share.json is left behind.
    expect(await readdir(path.join(cwd, ".threenative"))).toEqual(["share.json"]);
    await site.close();
  });

  it("retries a first deploy whose reply was lost with the same key, so it lands on one game", async () => {
    const cwd = await projectDir({ "build:web": "vite build" });
    let uploads = 0;
    const site = await fakeStudio(() => {
      uploads += 1;
      return uploads === 1
        ? { body: { message: "Studio fell over." }, status: 500 }
        : { body: { projectId: "p1", shareUrl: "https://x-share.example/" }, status: 200 };
    });
    const options = {
      cwd,
      out: () => {},
      runBuild: writeBuild,
      studio: site.origin,
      token: "tok-1",
    };

    const failure = await failureOf(deploy(options));

    expect(failure.code).toBe(4);
    expect(failure.message).toBe("Studio fell over.");
    const afterFailure = await readShareFile(cwd);
    // The key outlives the failed upload, and nothing else was written: no game id exists yet.
    expect(afterFailure?.deployKey).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u,
    );
    expect(Object.keys(afterFailure ?? {})).toEqual(["deployKey"]);

    const retried = await deploy(options);

    expect(retried).toEqual({ projectId: "p1", shareUrl: "https://x-share.example/" });
    expect(queryOf(site.requests[1]?.url).get("key")).toBe(afterFailure?.deployKey);
    expect(queryOf(site.requests[1]?.url).has("projectId")).toBe(false);
    expect(await readShareFile(cwd)).toEqual({
      deployKey: afterFailure?.deployKey,
      projectId: "p1",
    });
    await site.close();
  });

  it("asks for a fresh sign-in when Studio refuses the token", async () => {
    const cwd = await projectDir({ "build:web": "vite build" });
    const site = await fakeStudio(() => ({
      body: { message: "This token is no longer valid." },
      status: 401,
    }));

    const failure = await failureOf(
      deploy({ cwd, out: () => {}, runBuild: writeBuild, studio: site.origin, token: "tok-old" }),
    );

    expect(failure.code).toBe(3);
    expect(failure.message).toBe("This token is no longer valid. Run threenative login.");
    await site.close();
  });

  it("surfaces Studio's reason when it refuses the build", async () => {
    const cwd = await projectDir({ "build:web": "vite build" });
    const message = "The build has no index.html. Run build:web and deploy again.";
    const site = await fakeStudio(() => ({ body: { message }, status: 422 }));

    const failure = await failureOf(
      deploy({ cwd, out: () => {}, runBuild: writeBuild, studio: site.origin, token: "tok-1" }),
    );

    expect(failure.code).toBe(4);
    expect(failure.message).toBe(message);
    await site.close();
  });

  it("rejects a package with no build:web script", async () => {
    const cwd = await projectDir({ build: "vite build" });

    const failure = await failureOf(
      deploy({ cwd, out: () => {}, runBuild: writeBuild, token: "tok-1" }),
    );

    expect(failure.code).toBe(2);
    expect(failure.message).toBe("package.json has no build:web script.");
  });
});
