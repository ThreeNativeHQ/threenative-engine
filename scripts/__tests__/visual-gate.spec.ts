import { cp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  LOCAL_FRAMEWORK_PACKAGES,
  RENDER_LAYER_FILES,
  TEMPLATE_NAMES,
  VISUAL_SCORE_FLOOR,
  assertVisualPortAvailable,
  captureAllTemplates,
  inspectAllTemplates,
  validateVisualScores,
  visualServerProcessGroup,
  withVisualCaptureLease,
} from "../visual-gate.js";

describe("visual gate", () => {
  it("builds playtest before packages that import its export map", () => {
    const names = LOCAL_FRAMEWORK_PACKAGES.map(([name]) => name);
    expect(names.indexOf("@threenative/playtest")).toBeLessThan(names.indexOf("@threenative/core"));
    expect(names).toContain("threenative-engine-mcp");
  });

  it("terminates the complete visual server process group outside Windows", () => {
    expect(visualServerProcessGroup(1234, "linux")).toBe(-1234);
    expect(visualServerProcessGroup(1234, "win32")).toBe(1234);
  });

  it("releases the shared capture lease when a browser capture fails", async () => {
    const root = await makeTempDir("threenative-visual-capture-lease-");
    const lockRoot = path.join(root, "capture-lock");
    const holderPath = path.join(lockRoot, "lock", "holder.json");
    try {
      await expect(
        withVisualCaptureLease(
          async () => {
            const holder = JSON.parse(await readFile(holderPath, "utf8")) as { pid: number };
            expect(holder.pid).toBe(process.pid);
            throw new Error("browser capture failed");
          },
          { lockRoot },
        ),
      ).rejects.toThrow("browser capture failed");
      await expect(readFile(holderPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses to capture on a port already owned by another process", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("listener has no port");
    try {
      await expect(assertVisualPortAvailable(address.port)).rejects.toThrow(
        "TN_VISUAL_PORT_IN_USE",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("finds the six live render files and quality floor in every template", () => {
    const results = inspectAllTemplates();
    expect(results).toHaveLength(TEMPLATE_NAMES.length);
    for (const result of results) {
      expect(result.errors, result.template).toEqual([]);
      for (const file of RENDER_LAYER_FILES) expect(result.files, result.template).toContain(file);
    }
  });

  it("follows a live core WorldEnvironment and keeps a local pipeline implementation", async () => {
    const root = await makeTempDir("threenative-visual-core-world-");
    const kit = path.join(root, "core-world-kit");
    try {
      await cp(path.resolve("packages/create-threenative/templates/platformer"), kit, {
        recursive: true,
      });
      const manifest = JSON.parse(await readFile(path.join(kit, "kit.json"), "utf8")) as {
        name: string;
      };
      await writeFile(
        path.join(kit, "kit.json"),
        `${JSON.stringify({ ...manifest, name: "core-world-kit" })}\n`,
      );
      const inspect = () =>
        inspectAllTemplates(root).find(({ template }) => template === "core-world-kit");
      expect(inspect()?.errors).toEqual([]);

      const postPath = path.join(kit, "src/render/postprocessing.ts");
      const post = await readFile(postPath, "utf8");
      await writeFile(postPath, post.replaceAll("new WorldEnvironment(", "constructWorld("));
      expect(inspect()?.errors).toContain("core-world-kit: render pipeline is missing toneMapping");

      await writeFile(
        postPath,
        post.replace(
          'import { WorldEnvironment } from "@threenative/core"',
          'import { WorldEnvironment } from "./world-environment.js"',
        ),
      );
      expect(inspect()?.errors).toContain("core-world-kit: render pipeline is missing toneMapping");

      await writeFile(
        path.join(kit, "src/render/worldEnvironment.ts"),
        'export const markers = ["toneMapping", "toneMappingExposure", "createRenderChain", "bloom("];\n',
      );
      expect(inspect()?.errors).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("asks for soft shadow-map settings only from a light that casts a shadow", async () => {
    const root = await makeTempDir("threenative-visual-shadow-");
    const kit = path.join(root, "shadow-kit");
    try {
      await cp(path.resolve("packages/create-threenative/templates/platformer"), kit, {
        recursive: true,
      });
      const manifest = JSON.parse(await readFile(path.join(kit, "kit.json"), "utf8")) as {
        name: string;
      };
      await writeFile(
        path.join(kit, "kit.json"),
        `${JSON.stringify({ ...manifest, name: "shadow-kit" })}\n`,
      );
      const lightingPath = path.join(kit, "src/render/lighting.ts");
      const lighting = await readFile(lightingPath, "utf8");
      expect(lighting).toMatch(/castShadow\s*=\s*true/u);
      // Plain PCF with a radius is the soft filter three honours, so it passes; PCF without one does not.
      await writeFile(lightingPath, lighting.replaceAll("PCFSoftShadowMap", "PCFShadowMap"));
      const widened = inspectAllTemplates(root).find(({ template }) => template === "shadow-kit");
      expect(widened?.errors).not.toContain("shadow-kit: lighting.ts is missing PCFSoftShadowMap");
      const stripped = lighting
        .replaceAll("PCFSoftShadowMap", "PCFShadowMap")
        .replaceAll(/key\.shadow\.radius\s*=\s*\d+;/gu, "");
      await writeFile(lightingPath, stripped);
      const casting = inspectAllTemplates(root).find(({ template }) => template === "shadow-kit");
      expect(casting?.errors).toContain("shadow-kit: lighting.ts is missing PCFSoftShadowMap");

      await writeFile(
        lightingPath,
        stripped.replaceAll(/castShadow\s*=\s*true/gu, "castShadow = false"),
      );
      const unlit = inspectAllTemplates(root).find(({ template }) => template === "shadow-kit");
      expect(unlit?.errors).not.toContain("shadow-kit: lighting.ts is missing PCFSoftShadowMap");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers an unregistered broken template and reports its missing render file", async () => {
    const root = await makeTempDir("threenative-visual-discovery-");
    const broken = path.join(root, "unregistered-broken");
    try {
      await cp(path.resolve("packages/create-threenative/templates/platformer"), broken, {
        recursive: true,
      });
      const manifest = JSON.parse(await readFile(path.join(broken, "kit.json"), "utf8")) as {
        name: string;
      };
      await writeFile(
        path.join(broken, "kit.json"),
        `${JSON.stringify({ ...manifest, name: "unregistered-broken" })}\n`,
      );
      await unlink(path.join(broken, "src/render/postprocessing.ts"));

      const result = inspectAllTemplates(root).find(
        ({ template }) => template === "unregistered-broken",
      );
      expect(result?.errors).toContain("unregistered-broken: missing src/render/postprocessing.ts");
      expect(result?.errors).toContain(
        "unregistered-broken: render pipeline is missing toneMapping",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists every template capture through the production orchestration", async () => {
    const root = await makeTempDir("threenative-visual-capture-sync-");
    const visualRoot = path.join(root, "visuals");
    try {
      const captures = await captureAllTemplates(
        path.join(root, "capture-root"),
        {},
        {
          captureTemplate: async (template) => ({
            content: Buffer.from(`${template} visual-gate capture`),
            stats: {
              brightPixelRatio: 1,
              contentRatio: 1,
              distinctColors: 8,
              height: 1,
              luminanceStdDev: 1,
              maxLuminance: 1,
              width: 1,
            },
          }),
          visualRoot,
        },
      );

      expect(captures.map(({ template }) => template)).toEqual([...TEMPLATE_NAMES]);
      for (const template of TEMPLATE_NAMES) {
        const capture = Buffer.from(`${template} visual-gate capture`);
        expect(await readFile(path.join(visualRoot, `${template}.png`))).toEqual(capture);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects missing or below-floor human scores", () => {
    expect(() => validateVisualScores({})).toThrow("TN_VISUAL_SCORE_INVALID");
    const scores = Object.fromEntries(TEMPLATE_NAMES.map((template) => [template, 4]));
    expect(() =>
      validateVisualScores({
        templates: { ...scores, platformer: 3 },
        parity: { framework: 4, vanilla: 4 },
      }),
    ).toThrow(`TN_VISUAL_SCORE_FLOOR: platformer scored 3; floor is ${VISUAL_SCORE_FLOOR}.`);
  });

  it("rejects stale template score entries", () => {
    const templates = Object.fromEntries(TEMPLATE_NAMES.map((template) => [template, 4]));
    expect(() =>
      validateVisualScores({
        templates: { ...templates, retired: 4 },
        parity: { framework: 4, vanilla: 4 },
      }),
    ).toThrow("TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing none; stale retired.");
  });

  it("accepts a complete score file only at or above the floor", () => {
    const templates = Object.fromEntries(TEMPLATE_NAMES.map((template) => [template, 4]));
    const scores = validateVisualScores({
      templates,
      parity: { framework: 4, vanilla: 4 },
    });
    expect(scores.templates).toEqual(templates);
  });
});
