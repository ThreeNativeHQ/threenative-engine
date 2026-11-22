import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
async function fakeStudio(handler: (request: IRequestRecord) => IReply): Promise<IFakeStudio> {
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

  it("publishes the build and keeps the same link on the next deploy", async () => {
    const cwd = await projectDir({ "build:web": "vite build" });
    const site = await fakeStudio(() => ({
      body: { projectId: "p1", shareUrl: "https://x-share.example/" },
      status: 200,
    }));
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
      url: "/api/cli/share?name=game",
    });
    expect(entry(site.requests[0]?.body ?? Buffer.alloc(0), "index.html")).toBe("<p>hi</p>");
    // The link alone on the last stdout line: an agent parses that line, not the prose above it.
    expect(lines.at(-1)).toBe("https://x-share.example/");
    const shareFile = path.join(cwd, ".threenative", "share.json");
    expect(await readFile(shareFile, "utf8")).toBe('{\n  "projectId": "p1"\n}\n');
    expect(JSON.parse(await readFile(shareFile, "utf8"))).toEqual({ projectId: "p1" });

    const second = await deploy(options);

    expect(site.requests[1]?.url).toBe("/api/cli/share?name=game&projectId=p1");
    expect(second).toEqual(first);
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
