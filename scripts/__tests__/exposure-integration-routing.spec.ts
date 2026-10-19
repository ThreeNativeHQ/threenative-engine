import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const selector = new URL("../ci-integration-scope.mjs", import.meta.url).href;
const { integrationSelection } = await import(selector);
it.each(["exposure", "cold-boot"])("routes actual exposure producers to %s", async (lane) => {
  const source = await readFile(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  );
  const selected = (file: string) =>
    integrationSelection({ before: source, after: source, files: [file] }).lanes[lane];
  for (const file of [
    "autoExposure",
    "exposure",
    "exposureGraph",
    "exposureReadback",
    "worldEnvironment",
  ]) {
    expect(selected(`packages/create-threenative/template-assets/${file}.ts`), file).toBe(true);
    expect(
      selected(`packages/create-threenative/templates/starter/src/render/${file}.ts`),
      file,
    ).toBe(true);
  }
  for (const file of [
    "packages/core/src/game.ts",
    "packages/core/src/renderer-config.ts",
    "packages/playtest/src/runner/bridgeClient.ts",
    "packages/runtime-native/src/webgpu/bindings_resources.cpp",
  ]) {
    expect(selected(file), file).toBe(true);
  }
  expect(selected("packages/create-threenative/template-assets/vegetation.ts")).toBe(false);
  expect(selected("packages/create-threenative/templates/starter/src/render/lighting.ts")).toBe(
    false,
  );
});

it("routes the actual exposure policy imported by tone and generated worlds", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  );
  const world = await readFile(
    new URL(
      "../../packages/create-threenative/template-assets/worldEnvironment.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(world).toMatch(/exposureSettings.*from "\.\/exposure\.js"/u);
  for (const path of ["template-assets/exposure.ts", "templates/rain/src/render/exposure.ts"]) {
    const result = integrationSelection({
      before: source,
      after: source,
      files: [`packages/create-threenative/${path}`],
    });
    expect(result.lanes.tone).toBe(true);
    expect(result.lanes.exposure).toBe(true);
    expect(result.lanes["cold-boot"]).toBe(true);
    expect(result.lanes["fluid-particles"]).toBe(false);
  }
});
