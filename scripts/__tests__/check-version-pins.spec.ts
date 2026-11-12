import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { checkVersionPins } from "../check-version-pins.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await makeTempDir("threenative-version-pins-");
  temporaryRoots.push(root);
  return root;
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function pinFixture(): Promise<string> {
  const root = await fixtureRoot();
  await writeJson(root, "packages/core/package.json", {
    name: "@threenative/core",
    version: "1.0.0",
  });
  await writeJson(root, "packages/physics/package.json", {
    name: "@threenative/physics",
    version: "1.0.0",
  });
  await writeJson(root, "packages/runtime-native/package.json", {
    name: "@threenative/runtime-native",
    version: "1.0.0",
  });
  await writeJson(root, "packages/create-threenative/package.json", {
    name: "create-threenative",
    version: "2.0.0",
  });
  await writeJson(root, "packages/engine-mcp/package.json", {
    name: "threenative-engine-mcp",
    version: "3.0.0",
  });
  for (const template of ["alpha", "beta"]) {
    await writeJson(root, `packages/create-threenative/templates/${template}/package.json`, {
      dependencies: {
        "@threenative/core": ">=1.0.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: {
        "create-threenative": "2.0.0",
        "threenative-engine-mcp": "3.0.0",
      },
    });
  }
  await writeFile(
    path.join(root, "packages/runtime-native/CMakeLists.txt"),
    [
      'file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" MYSTRAL_PACKAGE_JSON)',
      'string(JSON MYSTRAL_PACKAGE_VERSION GET "${MYSTRAL_PACKAGE_JSON}" version)',
      "project(MystralNativeRuntime VERSION ${MYSTRAL_PACKAGE_VERSION})",
    ].join("\n"),
  );
  return root;
}

describe("template version pin gate", () => {
  it("passes when workspace and repeated third-party pins agree", async () => {
    await expect(checkVersionPins(await pinFixture())).resolves.toEqual([]);
  });

  it("names the template and expected workspace version when a pin drifts", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/alpha/package.json", {
      dependencies: {
        "@threenative/core": "9.9.9",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    const findings = await checkVersionPins(root);
    expect(findings.join("\n")).toContain(
      "template alpha pins @threenative/core at 9.9.9; expected workspace version 1.0.0",
    );
  });

  it("rejects an unknown internal-scope dependency instead of treating it as third-party", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/alpha/package.json", {
      dependencies: {
        "@threenative/core": ">=1.0.0",
        "@threenative/croe": "1.0.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    const findings = await checkVersionPins(root);
    expect(findings.join("\n")).toContain(
      "template alpha references unknown internal package @threenative/croe",
    );
  });

  it("requires repeated third-party pins to stay identical", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/beta/package.json", {
      dependencies: {
        "@threenative/core": ">=1.0.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "20.0.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    await expect(checkVersionPins(root)).resolves.toEqual([
      "third-party dependency react is 19.2.0 in template alpha but 20.0.0 in template beta",
    ]);
  });

  it("accepts a floor below the workspace version, because a game resolves the newest engine", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/alpha/package.json", {
      dependencies: {
        "@threenative/core": ">=0.4.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    await expect(checkVersionPins(root)).resolves.toEqual([]);
  });

  it("rejects a floor above the workspace version, which no install could satisfy", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/alpha/package.json", {
      dependencies: {
        "@threenative/core": ">=2.0.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    const findings = await checkVersionPins(root);
    expect(findings.join("\n")).toContain(
      "template alpha pins @threenative/core at >=2.0.0; expected workspace version 1.0.0 as >=1.0.0",
    );
  });

  it("rejects an exact internal pin that is not the workspace version", async () => {
    const root = await pinFixture();
    await writeJson(root, "packages/create-threenative/templates/alpha/package.json", {
      dependencies: {
        "@threenative/core": "0.9.0",
        "@threenative/physics": ">=1.0.0",
        "@threenative/runtime-native": ">=1.0.0",
        react: "19.2.0",
      },
      devDependencies: { "create-threenative": "2.0.0", "threenative-engine-mcp": "3.0.0" },
    });

    const findings = await checkVersionPins(root);
    expect(findings.join("\n")).toContain("template alpha pins @threenative/core at 0.9.0");
  });
});
