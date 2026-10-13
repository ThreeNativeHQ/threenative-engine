import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const server = {
    close: vi.fn(),
    listen: vi.fn(),
    resolvedUrls: { local: ["http://127.0.0.1:4173"] },
  };
  const display = {
    env: {},
    release: vi.fn(),
    strategy: { kind: "existing" as const, display: ":0" },
  };
  return {
    browserLaunch: vi.fn(),
    createProject: vi.fn(),
    createServer: vi.fn(),
    display,
    fs: {
      mkdir: vi.fn(),
      mkdtemp: vi.fn(),
      symlink: vi.fn(),
      writeFile: vi.fn(),
    },
    provideDisplay: vi.fn(),
    server,
  };
});

vi.mock("node:fs/promises", () => fixture.fs);
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: (specifier: string) => specifier,
  }),
}));
vi.mock("playwright", () => ({ chromium: { launch: fixture.browserLaunch } }));
vi.mock("vite", () => ({ createServer: fixture.createServer }));
vi.mock("../src/runner/captureEnvironment.js", () => ({ provideDisplay: fixture.provideDisplay }));
vi.mock("../../create-threenative/src/index.ts", () => ({ createProject: fixture.createProject }));

const importMeasurement = () => {
  vi.resetModules();
  return import("../src/runner/measure-resolution-scale.js");
};

beforeEach(() => {
  vi.resetModules();
  fixture.browserLaunch.mockReset();
  fixture.createProject.mockReset().mockResolvedValue(undefined);
  fixture.createServer.mockReset().mockResolvedValue(fixture.server);
  fixture.display.release.mockReset().mockResolvedValue(undefined);
  fixture.fs.mkdir.mockReset().mockResolvedValue(undefined);
  fixture.fs.mkdtemp.mockReset().mockResolvedValue("/tmp/prd564-starter-");
  fixture.fs.symlink.mockReset().mockResolvedValue(undefined);
  fixture.fs.writeFile.mockReset().mockResolvedValue(undefined);
  fixture.provideDisplay.mockReset().mockResolvedValue(fixture.display);
  fixture.server.close.mockReset().mockResolvedValue(undefined);
  fixture.server.listen.mockReset().mockResolvedValue(undefined);
});

test("startup failures close acquired resources and preserve the originating error", async () => {
  const displayError = new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: xdpyinfo failed");
  fixture.provideDisplay.mockRejectedValue(displayError);
  await expect(importMeasurement()).rejects.toBe(displayError);
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.browserLaunch).not.toHaveBeenCalled();

  const browserError = new Error("browser launch failed");
  fixture.server.close.mockClear();
  fixture.provideDisplay.mockResolvedValue(fixture.display);
  fixture.browserLaunch.mockRejectedValue(browserError);
  await expect(importMeasurement()).rejects.toBe(browserError);
  expect(fixture.display.release).toHaveBeenCalledOnce();
  expect(fixture.server.close).toHaveBeenCalledOnce();

  const listenError = new Error("server listen failed");
  fixture.server.close.mockClear();
  fixture.provideDisplay.mockClear();
  fixture.server.listen.mockRejectedValue(listenError);
  await expect(importMeasurement()).rejects.toBe(listenError);
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.provideDisplay).not.toHaveBeenCalled();
});
