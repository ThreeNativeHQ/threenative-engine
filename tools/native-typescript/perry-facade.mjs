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

/** Reuse the native engine's shipped addons and zustand's installed vanilla ESM source. */
function stageAddons(project, three) {
  const write = (name, code) => {
    const file = path.join(three, "addons", name.replace(/\.js$/u, ".ts"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
  };
  const addon = (name, file) =>
    write(name, `export * from ${JSON.stringify(`../../engine/src/addons/${file}.js`)};\n`);
  addon("utils/BufferGeometryUtils.js", "buffer-geometry-utils");
  for (const name of ["GLTFLoader", "HDRLoader", "KTX2Loader", "DRACOLoader"])
    addon(`loaders/${name}.js`, "perry-loaders");
  addon("libs/meshopt_decoder.module.js", "perry-loaders");
  write(
    "utils/SkeletonUtils.js",
    'import { SkeletonUtils } from "../../three.js";\nexport const clone = (root) => SkeletonUtils.clone(root);\n',
  );
  write(
    "geometries/RoundedBoxGeometry.js",
    'export { RoundedBoxGeometry } from "../../three.js";\n',
  );
  for (const name of ["BloomNode", "DenoiseNode", "GTAONode", "SMAANode"])
    write(
      `tsl/display/${name}.js`,
      'export * from "../../../engine/src/addons/post-effects-web.js";\n',
    );
  const require = createRequire(path.join(repo, "packages/core/package.json"));
  const zustand = path.join(project, "node_modules/zustand");
  fs.mkdirSync(zustand, { recursive: true });
  fs.copyFileSync(
    path.join(path.dirname(require.resolve("zustand/package.json")), "esm/vanilla.mjs"),
    path.join(zustand, "vanilla.ts"),
  );
  fs.writeFileSync(
    path.join(zustand, "package.json"),
    JSON.stringify({ name: "zustand", type: "module", main: "vanilla.ts" }),
  );
  const bvh = path.join(project, "node_modules/three-mesh-bvh");
  fs.mkdirSync(bvh, { recursive: true });
  fs.copyFileSync(path.join(facade, "src/addons/mesh-bvh.ts"), path.join(bvh, "index.ts"));
  fs.writeFileSync(
    path.join(bvh, "package.json"),
    JSON.stringify({ name: "three-mesh-bvh", type: "module", main: "index.ts" }),
  );
  // SkyMesh is portable generated source, so compile the installed addon over the shared facade.
  fs.copyFileSync(
    require.resolve("three/addons/objects/SkyMesh.js"),
    path.join(three, "engine/src/addons/sky-mesh.ts"),
  );
  addon("objects/SkyMesh.js", "sky-mesh");
}

export function stageSharedFacade(project, bridge) {
  const three = path.join(project, "node_modules/three");
  fs.mkdirSync(three, { recursive: true });
  for (const dir of ["src", "api"])
    fs.cpSync(path.join(facade, dir), path.join(three, "engine", dir), { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(facade, "api/catalog.json"), "utf8"));
  const names = [...new Set([...upstreamExportNames(), "SkeletonUtils", "RoundedBoxGeometry"])];
  const code = `import { bindPerryEngine } from "./engine/src/perry-entry.js";\nconst bound = bindPerryEngine(${JSON.stringify(names)});\n${[...names, "__tnTsl", "__tnLoadAsset"].map((name) => `export const ${name} = bound.${name};`).join("\n")}\n`;
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
  stageAddons(project, three);
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
