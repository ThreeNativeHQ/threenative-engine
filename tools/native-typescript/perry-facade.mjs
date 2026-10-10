// Stage the shared facade without changing game source or installing workspace packages.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const facade = path.join(repo, "packages/three-native");
export const PERRY_TRANSPORT = "tn-native-transport";

/** Export spelling only; no upstream implementation enters the staged game. */
export function upstreamExportNames() {
  const require = createRequire(path.join(facade, "package.json"));
  return [
    ...new Set(["three", "three/webgpu", "three/tsl"].flatMap((id) => Object.keys(require(id)))),
  ]
    .filter((name) => name !== "default")
    .sort();
}

export function stageSharedFacade(project, bridge) {
  const three = path.join(project, "node_modules/three");
  fs.mkdirSync(three, { recursive: true });
  for (const dir of ["src", "api"])
    fs.cpSync(path.join(facade, dir), path.join(three, "engine", dir), { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(facade, "api/catalog.json"), "utf8"));
  const names = upstreamExportNames();
  const code = `import { bindPerryEngine } from "./engine/src/perry-entry.js";\nconst bound = bindPerryEngine(${JSON.stringify(names)});\n${names.map((name) => `export const ${name} = bound.${name};`).join("\n")}\n`;
  fs.writeFileSync(path.join(three, "three.ts"), code);
  for (const name of ["webgpu.ts", "tsl.ts", "three-tsl.ts"])
    fs.writeFileSync(path.join(three, name), 'export * from "./three.js";\n');
  fs.writeFileSync(
    path.join(three, "package.json"),
    JSON.stringify({
      name: "three",
      version: catalog.threeVersion ?? "0.185.1",
      main: "three.ts",
      types: "three.ts",
    }),
  );
  const adapter = path.join(project, "node_modules", PERRY_TRANSPORT);
  fs.cpSync(path.join(facade, "perry"), adapter, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}target${path.sep}`),
  });
  if (bridge) {
    const manifestFile = path.join(adapter, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    Object.assign(manifest.perry.nativeLibrary.targets.linux, {
      libDirs: bridge.libDirs,
      libs: bridge.libs,
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }
  const rootFile = path.join(project, "package.json");
  const root = fs.existsSync(rootFile)
    ? JSON.parse(fs.readFileSync(rootFile, "utf8"))
    : { name: "tn-shared-facade", private: true };
  root.dependencies = {
    ...root.dependencies,
    three: "file:node_modules/three",
    [PERRY_TRANSPORT]: `file:node_modules/${PERRY_TRANSPORT}`,
  };
  root.perry = {
    ...root.perry,
    allow: {
      ...root.perry?.allow,
      nativeLibrary: [...new Set([...(root.perry?.allow?.nativeLibrary ?? []), PERRY_TRANSPORT])],
    },
  };
  fs.writeFileSync(rootFile, JSON.stringify(root, null, 2));
  return { three, adapter, names };
}
