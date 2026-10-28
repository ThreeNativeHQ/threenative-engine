import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { parseArgs, startPoseLab } from "../src/server.js";

describe("Pose Lab server", () => {
  it("accepts arbitrary project directories and explicit CLI metadata", () => {
    expect(parseArgs(["--project", "/tmp/any-game", "--port", "4521"])).toEqual({
      port: 4521,
      project: "/tmp/any-game",
    });
    expect(() => parseArgs(["--port", "0"])).toThrow("1 to 65535");
  });

  it("reports the port it actually bound, so two views can coexist", async () => {
    const project = await makeTempDir("animation-view-");
    const first = await startPoseLab({ port: 0, project });
    onTestFinished(() => first.close());
    const second = await startPoseLab({ port: 0, project });
    onTestFinished(() => second.close());

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(first.port);
    expect((await fetch(`http://127.0.0.1:${first.port}/pose`)).status).toBe(200);
  });

  it("discovers GLBs, blocks traversal, and round-trips animation recipes", async () => {
    const project = await makeTempDir("pose-lab-");
    await mkdir(path.join(project, "models"));
    await writeFile(path.join(project, "models", "host.glb"), new Uint8Array([1, 2, 3]));
    await writeFile(path.join(project, "models", "prop.glb"), new Uint8Array([4, 5]));
    await writeFile(path.join(project, "outside.glb"), new Uint8Array([9]));
    const server = await startPoseLab({ port: 4521, project });
    onTestFinished(() => server.close());

    const models = await fetch("http://127.0.0.1:4521/api/models");
    expect(await models.json()).toEqual({
      models: ["models/host.glb", "models/prop.glb", "outside.glb"],
    });
    expect((await fetch("http://127.0.0.1:4521/api/model?path=..%2Foutside.glb")).status).toBe(404);

    const recipe = {
      anchor: { id: "right-hand", node: "RightHand", source: "detected" },
      animations: {
        Death: {
          time: 0.7,
          transform: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] },
        },
        Idle: {
          time: 0.2,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
        },
      },
      attached: "models/prop.glb",
      host: "models/host.glb",
      version: 2,
    };
    const saved = await fetch("http://127.0.0.1:4521/api/recipe?path=poses%2Fhost-prop.json", {
      body: JSON.stringify({ recipe }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    expect(
      JSON.parse(await readFile(path.join(project, "poses", "host-prop.json"), "utf8")),
    ).toEqual(recipe);
    const loaded = await fetch("http://127.0.0.1:4521/api/recipe?path=poses%2Fhost-prop.json");
    expect(await loaded.json()).toMatchObject({ recipe });
  });
});
