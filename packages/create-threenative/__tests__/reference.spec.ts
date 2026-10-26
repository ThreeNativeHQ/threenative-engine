import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const SCRIPT = path.resolve("packages/create-threenative/agent-files/scripts/reference.mjs");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

interface IServerFixture {
  endpoint: string;
  capabilities: string;
  requests: Array<{ body: Record<string, unknown>; method: string; path: string }>;
  close: () => Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fixtureServer(
  response: unknown = {
    choices: [
      { message: { images: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }] } },
    ],
  },
  capabilities: unknown = {
    data: [
      {
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
        supported_parameters: ["modalities"],
      },
    ],
  },
): Promise<IServerFixture> {
  const requests: IServerFixture["requests"] = [];
  const server = createServer(async (request: IncomingMessage, responseStream: ServerResponse) => {
    const body = await bodyOf(request);
    requests.push({
      body: body === "" ? {} : JSON.parse(body),
      method: request.method ?? "",
      path: request.url ?? "",
    });
    responseStream.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      responseStream.end(JSON.stringify(capabilities));
      return;
    }
    responseStream.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    endpoint: `${base}/v1/chat/completions`,
    capabilities: `${base}/v1/models/meta%2Fmuse-image/endpoints`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function runReference(
  root: string,
  args: string[],
  fixture: IServerFixture,
  extraEnv: Record<string, string> = {},
) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      OPENROUTER_API_KEY: "test-key",
      TN_REFERENCE_ENDPOINT: fixture.endpoint,
      TN_REFERENCE_CAPABILITIES_ENDPOINT: fixture.capabilities,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const [code] = (await once(child, "close")) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function runFixture(root: string) {
  const runDirectory = path.join(root, ".dream-loop", "run-1");
  await mkdir(runDirectory, { recursive: true });
  const prompt = path.join(runDirectory, "prompt.txt");
  await writeFile(prompt, "A lantern tower beside a journal hub; preserve the prompt exactly.");
  const record = {
    schemaVersion: 1,
    runId: "run-1",
    projectRoot: root,
    artifactRoot: ".dream-loop/run-1",
    limits: {
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      maxImageRequests: 4,
      maxRounds: 6,
    },
    requests: { pending: [], completed: [], unknown: [], failed: [] },
    rounds: [],
    decisionHistory: [],
  };
  const recordFile = path.join(runDirectory, "run.json");
  await writeFile(recordFile, `${JSON.stringify(record)}\n`);
  return { recordFile, runDirectory, prompt };
}

describe("generated reference script", () => {
  it("writes valid image bytes, preserves the prompt, and records provenance", async () => {
    const root = await makeTempDir("threenative-reference-");
    const fixture = await fixtureServer();
    try {
      const files = await runFixture(root);
      const result = await runReference(
        root,
        [
          "--record",
          ".dream-loop/run-1/run.json",
          "--request-id",
          "target-001",
          "--prompt-file",
          ".dream-loop/run-1/prompt.txt",
          "--out",
          ".dream-loop/run-1/target.png",
        ],
        fixture,
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "generated",
        requestId: "target-001",
        mime: "image/png",
      });
      await expect(readFile(path.join(files.runDirectory, "target.png"))).resolves.toEqual(PNG);
      expect(fixture.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
      const request = fixture.requests.find(({ method }) => method === "POST")?.body;
      const content =
        (request?.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]
          ?.content ?? [];
      expect(content.find((part) => part.type === "text")?.text).toBe(
        "A lantern tower beside a journal hub; preserve the prompt exactly.",
      );
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("asks OpenRouter for the model's endpoints with the slash in the model id kept", async () => {
    const root = await makeTempDir("threenative-reference-");
    const fixture = await fixtureServer();
    try {
      await runFixture(root);
      const result = await runReference(
        root,
        [
          "--record",
          ".dream-loop/run-1/run.json",
          "--request-id",
          "target-001",
          "--prompt-file",
          ".dream-loop/run-1/prompt.txt",
          "--out",
          ".dream-loop/run-1/target.png",
        ],
        { ...fixture, endpoint: fixture.endpoint.replace("/v1/", "/api/v1/") },
        { TN_REFERENCE_CAPABILITIES_ENDPOINT: "" },
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fixture.requests.find(({ method }) => method === "GET")?.path).toBe(
        "/api/v1/models/meta/muse-image/endpoints",
      );
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reuses a completed request and never duplicates a POST after a crash", async () => {
    const root = await makeTempDir("threenative-reference-retry-");
    const fixture = await fixtureServer();
    try {
      await runFixture(root);
      const args = [
        "--record",
        ".dream-loop/run-1/run.json",
        "--request-id",
        "target-001",
        "--prompt-file",
        ".dream-loop/run-1/prompt.txt",
        "--out",
        ".dream-loop/run-1/target.png",
      ];
      const crashed = await runReference(root, args, fixture, {
        TN_REFERENCE_ABORT_AFTER_POST: "1",
      });
      expect(crashed.code, `${crashed.stdout}\n${crashed.stderr}`).toBe(1);
      const requestCount = fixture.requests.filter(({ method }) => method === "POST").length;
      const resumed = await runReference(root, args, fixture);
      expect(resumed.code).toBe(1);
      expect(fixture.requests.filter(({ method }) => method === "POST")).toHaveLength(requestCount);
      const record = JSON.parse(
        await readFile(path.join(root, ".dream-loop/run-1/run.json"), "utf8"),
      ) as { requests: { unknown: Array<{ requestId: string }> } };
      expect(record.requests.unknown.some(({ requestId }) => requestId === "target-001")).toBe(
        true,
      );
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses missing credentials, wrong media, and unsupported output paths", async () => {
    const root = await makeTempDir("threenative-reference-errors-");
    const fixture = await fixtureServer({ choices: [{ message: { content: "not an image" } }] });
    try {
      await runFixture(root);
      const args = [
        "--record",
        ".dream-loop/run-1/run.json",
        "--request-id",
        "target-001",
        "--prompt-file",
        ".dream-loop/run-1/prompt.txt",
        "--out",
        ".dream-loop/run-1/target.png",
      ];
      const missing = await runReference(root, args, fixture, { OPENROUTER_API_KEY: "" });
      expect(missing.code, `${missing.stdout}\n${missing.stderr}`).toBe(2);
      const invalid = await runReference(root, args, fixture);
      expect(invalid.code, `${invalid.stdout}\n${invalid.stderr}`).toBe(1);
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        action: "failed",
        category: "invalid-image",
      });
      const outside = await runReference(root, [...args.slice(0, -1), "../target.png"], fixture);
      expect(outside.code, `${outside.stdout}\n${outside.stderr}`).toBe(2);
      expect(fixture.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when a model advertises image input but not image output", async () => {
    const root = await makeTempDir("threenative-reference-input-only-");
    const fixture = await fixtureServer(undefined, {
      data: [
        {
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["modalities"],
        },
      ],
    });
    try {
      await runFixture(root);
      const result = await runReference(
        root,
        [
          "--record",
          ".dream-loop/run-1/run.json",
          "--request-id",
          "target-001",
          "--prompt-file",
          ".dream-loop/run-1/prompt.txt",
          "--out",
          ".dream-loop/run-1/target.png",
        ],
        fixture,
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "failed",
        category: "capability",
      });
      expect(fixture.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("sends original reference bytes for an authorized edit", async () => {
    const root = await makeTempDir("threenative-reference-edit-");
    const fixture = await fixtureServer();
    try {
      const { runDirectory } = await runFixture(root);
      await writeFile(path.join(runDirectory, "baseline.png"), PNG);
      const result = await runReference(
        root,
        [
          "--record",
          ".dream-loop/run-1/run.json",
          "--request-id",
          "edit-001",
          "--prompt-file",
          ".dream-loop/run-1/prompt.txt",
          "--reference",
          ".dream-loop/run-1/baseline.png",
          "--out",
          ".dream-loop/run-1/edited.png",
        ],
        fixture,
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const request = fixture.requests.find(({ method }) => method === "POST")?.body;
      const content =
        (
          request?.messages as Array<{
            content: Array<{ type: string; image_url?: { url: string } }>;
          }>
        )[0]?.content ?? [];
      expect(content.find((part) => part.type === "image_url")?.image_url?.url).toContain(
        `base64,${PNG.toString("base64")}`,
      );
    } finally {
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
