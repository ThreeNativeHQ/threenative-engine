import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createServer, type Server } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, beforeAll, afterAll } from "vitest";

import { exitCodeForReport } from "../src/runner/cli.js";
import { resolveBrowserArguments } from "../src/runner/browser.js";
import { runStandalonePlaytest } from "../src/runner/runner.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let fixtureServer: Server;
let origin: string;

beforeAll(async () => {
  const html = await readFile(join(fixtureDirectory, "app.html"));
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((ready) => fixtureServer.listen(0, "127.0.0.1", ready));
  const address = fixtureServer.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server has no port.");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => fixtureServer.close(() => closed()));
});

test("browser arguments are copied into capture provenance without mutation", () => {
  const args = ["--enable-unsafe-webgpu"];
  const resolved = resolveBrowserArguments(args);

  expect(resolved).toEqual(args);
  expect(resolved).not.toBe(args);
});

test("the screenshot runner writes and regenerates capture provenance", { timeout: 20_000 }, async () => {
  const artifactDirectory = await makeTempDir("playtest-provenance-");

  const firstReport = await runVisualPlaytest(artifactDirectory, "rendered");
  expect(exitCodeForReport(firstReport)).toBe(0);
  const first = JSON.parse(await readFile(join(artifactDirectory, "capture.json"), "utf8"));
  expect(firstReport.capture).toEqual(first);
  expect(first).toMatchObject({
    adapter: expect.objectContaining({ renderer: expect.any(String), vendor: expect.any(String) }),
    captureMethod: "page.screenshot",
    rendererKind: "webgl",
    target: "web",
    viewport: { height: 360, width: 640 },
  });
  await unlink(join(artifactDirectory, "capture.json"));

  const secondReport = await runVisualPlaytest(artifactDirectory, "rendered");
  expect(exitCodeForReport(secondReport)).toBe(0);
  const second = JSON.parse(await readFile(join(artifactDirectory, "capture.json"), "utf8"));

  expect(second).toEqual(first);
  expect(secondReport.capture).toEqual(second);
});

test("missing adapter and renderer metadata fails without writing unknown provenance", async () => {
  const artifactDirectory = await makeTempDir("playtest-provenance-missing-");
  const report = await runVisualPlaytest(artifactDirectory, "good", ["--disable-gpu", "--disable-software-rasterizer"]);

  expect(exitCodeForReport(report)).toBe(2);
  expect(report.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING");
  await expect(readFile(join(artifactDirectory, "capture.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("generic WebGPU features and limits do not count as adapter identity", async () => {
  const artifactDirectory = await makeTempDir("playtest-provenance-generic-");
  const report = await runVisualPlaytest(artifactDirectory, "generic-adapter", ["--disable-gpu"]);

  expect(exitCodeForReport(report)).toBe(2);
  expect(report.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING");
  await expect(readFile(join(artifactDirectory, "capture.json"))).rejects.toMatchObject({ code: "ENOENT" });
  // An adapter that resolved is not a rejected request; the message has to keep them apart.
  expect(provenanceMessage(report)).toContain("resolved");
  expect(provenanceMessage(report)).not.toContain("rejected");
});

test("the missing-adapter diagnostic names why the adapter request failed", async () => {
  // `.catch(() => null)` used to throw the browser's reason away, so a page with no GPU and a page
  // misconfigured to request one reported the same unexplained "no adapter description".
  const artifactDirectory = await makeTempDir("playtest-provenance-rejected-");
  const report = await runVisualPlaytest(artifactDirectory, "adapter-rejected", ["--disable-gpu"]);

  expect(exitCodeForReport(report)).toBe(2);
  expect(report.pass).toBe(false);
  expect(provenanceMessage(report)).toContain("rejected");
  expect(provenanceMessage(report)).toContain("fixture-adapter-rejected");
  await expect(readFile(join(artifactDirectory, "capture.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

function provenanceMessage(report: { diagnostics: ReadonlyArray<{ code: string; message: string }> }): string {
  return report.diagnostics
    .filter(({ code }) => code === "TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING")
    .map(({ message }) => message)
    .join(" ");
}

async function runVisualPlaytest(
  artifactDirectory: string,
  mode: string,
  browserArgs?: readonly string[],
) {
  return runStandalonePlaytest({
    artifactDirectory,
    ...(browserArgs === undefined ? {} : { browserArgs }),
    headless: true,
    projectPath: fixtureDirectory,
    scenarioPath: "visual-capture-failure.playtest.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=${mode}`,
  });
}
