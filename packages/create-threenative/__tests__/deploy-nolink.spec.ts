import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { CliExit } from "../src/account.js";
import { deploy } from "../src/deploy.js";

// A volume with no hard links (some network and FAT mounts): `link` fails with ENOTSUP.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: async () => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
  },
}));

describe("threenative deploy on a volume with no hard links", () => {
  it("still claims one deploy key for two first deploys started together", async () => {
    const cwd = await makeTempDir("tn-deploy-nolink-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "game", scripts: { "build:web": "vite build" } }),
    );
    const options = {
      cwd,
      out: () => {},
      runBuild: async (root: string) => {
        await mkdir(path.join(root, "dist"), { recursive: true });
        await writeFile(path.join(root, "dist", "index.html"), "<p>hi</p>");
      },
      // Nothing listens here: each deploy claims its key, then fails to upload with exit 5.
      studio: "http://127.0.0.1:9",
      token: "tok-1",
    };

    const results = await Promise.allSettled([deploy(options), deploy(options)]);

    for (const result of results) {
      expect(result.status).toBe("rejected");
      const reason = (result as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(CliExit);
      expect((reason as CliExit).code).toBe(5);
    }
    const share = JSON.parse(await readFile(path.join(cwd, ".threenative", "share.json"), "utf8"));
    expect(share.deployKey).toMatch(/^[\da-f-]{36}$/u);
  });
});
