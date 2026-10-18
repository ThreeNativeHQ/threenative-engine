#!/usr/bin/env node
import { realpathSync, existsSync, readFileSync, statSync, accessSync, constants } from 'fs';
import path2 from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { execFileSync, execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os, { platform, homedir } from 'os';

var BLENDER_VERSION_FLOOR = Object.freeze({ major: 4, minor: 2 });
var BLENDER_INSTALL_GUIDANCE = Object.freeze({
  linux: "sudo snap install blender --classic   (or your distribution's package, or https://www.blender.org/download/)",
  macos: "brew install --cask blender   (or https://www.blender.org/download/)",
  windows: "winget install --id BlenderFoundation.Blender   (or https://www.blender.org/download/)"
});
function floorString() {
  return `${BLENDER_VERSION_FLOOR.major}.${BLENDER_VERSION_FLOOR.minor}`;
}
function installCommandFor(platformName = platform()) {
  if (platformName === "darwin") return BLENDER_INSTALL_GUIDANCE.macos;
  if (platformName === "win32") return BLENDER_INSTALL_GUIDANCE.windows;
  return BLENDER_INSTALL_GUIDANCE.linux;
}
function executableFile(candidate) {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function binaryNames(platformName) {
  return platformName === "win32" ? ["blender.exe", "blender.com"] : ["blender"];
}
function pathCandidates(environment, platformName) {
  const raw = environment.PATH ?? environment.Path ?? "";
  if (raw.trim().length === 0) return [];
  return raw.split(path2.delimiter).filter((directory) => directory.trim().length > 0).flatMap((directory) => binaryNames(platformName).map((name) => path2.join(directory, name)));
}
function conventionalCandidates(platformName, home) {
  if (platformName === "darwin") {
    return [
      "/Applications/Blender.app/Contents/MacOS/Blender",
      path2.join(home, "Applications/Blender.app/Contents/MacOS/Blender")
    ];
  }
  if (platformName === "win32") {
    const roots = [
      process.env.ProgramFiles ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
    ];
    return roots.flatMap(
      (root) => ["5.2", "5.1", "5.0", "4.5", "4.2"].map(
        (release) => path2.join(root, "Blender Foundation", `Blender ${release}`, "blender.exe")
      )
    );
  }
  return [
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/var/lib/flatpak/exports/bin/org.blender.Blender",
    path2.join(home, ".local/bin/blender")
  ];
}
function parseBlenderVersion(output) {
  const match = /^Blender\s+(\d+\.\d+(?:\.\d+)?)/mu.exec(output);
  return match?.[1];
}
function compareToFloor(version) {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(major) || Number.isNaN(minor)) return false;
  if (major !== BLENDER_VERSION_FLOOR.major) return major > BLENDER_VERSION_FLOOR.major;
  return minor >= BLENDER_VERSION_FLOOR.minor;
}
var probeBlenderVersion = (binary) => {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3e4
    });
    return parseBlenderVersion(output);
  } catch {
    return void 0;
  }
};
function resolveBlender(environment = process.env, options = {}) {
  const platformName = options.platform ?? platform();
  const home = options.home ?? environment.HOME ?? environment.USERPROFILE ?? homedir();
  const probeVersion = options.probeVersion ?? probeBlenderVersion;
  const minimumVersion = floorString();
  const install = BLENDER_INSTALL_GUIDANCE;
  const override = environment.THREENATIVE_BLENDER_PATH;
  if (override !== void 0 && override.trim().length > 0) {
    const candidate = path2.resolve(override.trim());
    if (!executableFile(candidate)) {
      return {
        available: false,
        cause: "blender-unreadable",
        detail: `THREENATIVE_BLENDER_PATH points at '${candidate}', which is not an executable file.`,
        install,
        minimumVersion,
        path: candidate
      };
    }
    return classify(candidate, probeVersion, minimumVersion, install);
  }
  const candidates = [
    ...pathCandidates(environment, platformName),
    ...conventionalCandidates(platformName, home)
  ];
  for (const candidate of candidates) {
    if (!executableFile(candidate)) continue;
    const classified = classify(candidate, probeVersion, minimumVersion, install);
    if (classified.cause !== "blender-unreadable") return classified;
  }
  return {
    available: false,
    cause: "blender-missing",
    detail: `No Blender ${minimumVersion} or newer was found. Set THREENATIVE_BLENDER_PATH, or install it: ${installCommandFor(platformName)}`,
    install,
    minimumVersion
  };
}
function classify(binary, probeVersion, minimumVersion, install) {
  const version = probeVersion(binary);
  if (version === void 0) {
    return {
      available: false,
      cause: "blender-unreadable",
      detail: `'${binary}' did not report a Blender version.`,
      install,
      minimumVersion,
      path: binary
    };
  }
  if (!compareToFloor(version)) {
    return {
      available: false,
      cause: "blender-too-old",
      detail: `Blender ${version} at '${binary}' is older than the supported floor ${minimumVersion}.`,
      install,
      minimumVersion,
      path: binary,
      version
    };
  }
  return {
    available: true,
    detail: `Blender ${version} at '${binary}'.`,
    install,
    minimumVersion,
    path: binary,
    version
  };
}

// src/bridge.ts
var BLENDER_SOURCE_EXTENSIONS = Object.freeze([
  "blend",
  "dae",
  "fbx",
  "obj"
]);
var RESULT_PREFIX = "TN_BLENDER_RESULT ";
var DEFAULT_TIMEOUT_MS = 3e5;
function blenderScriptsDirectory(environment = process.env) {
  const override = environment.THREENATIVE_BLENDER_SCRIPTS;
  if (override !== void 0 && override.trim().length > 0) return path2.resolve(override.trim());
  return path2.resolve(fileURLToPath(import.meta.url), "..", "..", "gpl");
}
function failure(cause, detail, stderr) {
  return {
    cause,
    detail,
    install: BLENDER_INSTALL_GUIDANCE,
    installCommand: installCommandFor(),
    ok: false,
    ...stderr === void 0 ? {} : { stderr }
  };
}
function temporaryRoot(environment) {
  const named = environment.TMPDIR ?? environment.TEMP ?? environment.TMP;
  if (named !== void 0 && named.trim().length > 0 && existsSync(named.trim())) {
    return path2.resolve(named.trim());
  }
  return os.tmpdir();
}
function unavailable(status) {
  const cause = status.cause === "blender-too-old" ? "blender-too-old" : status.cause === "blender-unreadable" ? "blender-unreadable" : "blender-missing";
  return failure(cause, status.detail);
}
function parseBlenderResult(stdout) {
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (line === void 0) return void 0;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return void 0;
  }
}
function runBlender(binary, script, request, timeoutMs, environment) {
  return new Promise((resolve) => {
    const args = [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "3",
      "--python",
      script,
      "--",
      JSON.stringify(request)
    ];
    execFile(
      binary,
      args,
      { encoding: "utf8", env: environment, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const killed = error?.killed === true;
        const code = error?.code;
        resolve({
          code: error === null ? 0 : typeof code === "number" ? code : null,
          stderr,
          stdout,
          timedOut: killed
        });
      }
    );
  });
}
function assertSourcePath(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'source' must be a non-empty path.");
  }
  return path2.resolve(source);
}
async function run(request, options) {
  const environment = options.environment ?? process.env;
  const status = resolveBlender(environment);
  if (!status.available || status.path === void 0) return unavailable(status);
  const scripts = options.scriptsDirectory ?? blenderScriptsDirectory(environment);
  const script = options.script ?? path2.join(scripts, "convert.py");
  if (!existsSync(script)) {
    return failure(
      "script-missing",
      `The Blender script '${script}' is not on disk. Set THREENATIVE_BLENDER_SCRIPTS to the package's gpl/ directory.`
    );
  }
  const temporary = await mkdtemp(path2.join(temporaryRoot(environment), "tn-blender-"));
  let outcome;
  try {
    outcome = await runBlender(
      status.path,
      script,
      request,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { ...environment, TEMP: temporary, TMP: temporary, TMPDIR: temporary }
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
  if (outcome.timedOut) {
    return failure(
      "timeout",
      `Blender did not finish within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
      outcome.stderr
    );
  }
  const summary = parseBlenderResult(outcome.stdout);
  if (outcome.code !== 0) {
    const named = outcome.stderr.split("\n").find((line) => line.startsWith("TN_BLENDER_ERROR:"));
    const noMeshes = named?.includes("produced no meshes") === true;
    return failure(
      noMeshes ? "no-meshes" : "convert-failed",
      named ?? `Blender exited ${outcome.code ?? "by signal"} for '${String(request.source)}'.`,
      outcome.stderr
    );
  }
  if (summary === void 0) {
    return failure(
      "unreadable-result",
      "Blender exited 0 but printed no readable result line; refusing to report a conversion that cannot be described.",
      outcome.stderr
    );
  }
  if (summary.meshes === 0) {
    return failure("no-meshes", `'${summary.source}' produced no meshes.`, outcome.stderr);
  }
  if (request.mode === "convert") {
    const out = summary.out;
    if (out === void 0 || !existsSync(out)) {
      return failure(
        "no-output",
        `Blender reported success but wrote no file at '${String(request.out)}'.`,
        outcome.stderr
      );
    }
  }
  return { ok: true, summary };
}
async function inspectModel(source, options = {}) {
  return run({ mode: "inspect", source: assertSourcePath(source) }, options);
}
async function convertModel(source, out, options = {}) {
  if (typeof out !== "string" || out.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'out' must be a non-empty path.");
  }
  return run(
    { mode: "convert", out: path2.resolve(out), source: assertSourcePath(source) },
    options
  );
}
async function runBlenderScript(script, request, options = {}) {
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'script' must be a non-empty path.");
  }
  return run(request, { ...options, script: path2.resolve(script) });
}
var PATH_PARAMETERS = [
  { description: "Path to the model to read.", name: "source", required: true },
  { description: "Path of the file to write.", name: "out", required: true }
];
var RECIPES = Object.freeze([
  Object.freeze({
    description: "Reduce triangle count to a requested fraction, preserving materials, UVs and rig. Reports trianglesBefore, trianglesAfter and achievedRatio.",
    name: "decimate",
    parameters: Object.freeze([
      ...PATH_PARAMETERS,
      {
        description: "Target fraction of the original triangles, 0 < ratio <= 1. Default 0.5.",
        name: "ratio",
        required: false
      }
    ]),
    script: "decimate.py"
  }),
  Object.freeze({
    description: "Give meshes a UV layer they do not have, so they can carry a texture or a lightmap. Reports uvLayersBefore and uvLayersAfter.",
    name: "unwrap",
    parameters: Object.freeze([
      ...PATH_PARAMETERS,
      {
        description: "Smart-project angle limit in degrees. Default 66.",
        name: "angleLimit",
        required: false
      },
      { description: "Island margin. Default 0.02.", name: "islandMargin", required: false },
      {
        description: "Only unwrap meshes with no UV layer at all. Default true.",
        name: "onlyMissing",
        required: false
      }
    ]),
    script: "unwrap.py"
  }),
  Object.freeze({
    description: "Bake ambient occlusion \u2014 computed from geometry \u2014 into a PNG. Reports the baked image's mean, min and max luminance.",
    name: "bake_ao",
    parameters: Object.freeze([
      ...PATH_PARAMETERS,
      { description: "Square texture size in pixels. Default 256.", name: "size", required: false },
      { description: "Cycles samples. Default 16.", name: "samples", required: false }
    ]),
    script: "bake_ao.py"
  }),
  Object.freeze({
    description: "Move animation clips from one armature's bone names onto another's. Fails when a clip resolves no track on the destination armature.",
    name: "retarget",
    parameters: Object.freeze([
      { description: "Model carrying the clips to move.", name: "source", required: true },
      { description: "Model whose armature receives them.", name: "target", required: true },
      { description: "Path of the .glb to write.", name: "out", required: true },
      {
        description: "Object mapping source bone name to destination bone name.",
        name: "map",
        required: true
      }
    ]),
    script: "retarget.py"
  }),
  Object.freeze({
    description: "Export a Blender-authored world as a ThreeNative world package v1: world.json, a raw uint16 heightmap, one GLB plus a decimated LOD1 per referenced scatter asset, per-cell chunk GLBs and placements.bin. Reads render-density instances, so viewport share tricks never leak in.",
    name: "export_world",
    parameters: Object.freeze([
      { description: "Path to the .blend world to read.", name: "source", required: true },
      { description: "Directory to write the package into.", name: "out", required: true },
      { description: "Cell edge length in metres.", name: "cell", required: true },
      {
        description: "Heightmap sample spacing in metres. Default 2.",
        name: "spacing",
        required: false
      }
    ]),
    script: "export_world.py"
  })
]);
function recipeNames() {
  return RECIPES.map((recipe) => recipe.name);
}
function findRecipe(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("blender_recipes requires a string 'name' argument, or none to list them all.");
  }
  const recipe = RECIPES.find((candidate) => candidate.name === name);
  if (recipe === void 0) {
    throw new Error(`Unknown recipe '${name}'. Shipped recipes: ${recipeNames().join(", ")}.`);
  }
  return recipe;
}
function recipePath(recipe, environment = process.env) {
  return path2.join(blenderScriptsDirectory(environment), "recipes", recipe.script);
}
function recipeSource(recipe, environment = process.env) {
  const file = recipePath(recipe, environment);
  if (!existsSync(file)) {
    throw new Error(`TN_BLENDER_RECIPE_MISSING: recipe '${recipe.name}' has no script at ${file}.`);
  }
  return readFileSync(file, "utf8");
}
async function runRecipe(name, request, options = {}) {
  const recipe = findRecipe(name);
  const environment = options.environment ?? process.env;
  const script = recipePath(recipe, environment);
  if (!existsSync(script)) {
    throw new Error(
      `TN_BLENDER_RECIPE_MISSING: recipe '${recipe.name}' has no script at ${script}.`
    );
  }
  for (const parameter of recipe.parameters) {
    if (!parameter.required) continue;
    if (request[parameter.name] === void 0) {
      throw new Error(`Recipe '${recipe.name}' requires the '${parameter.name}' argument.`);
    }
  }
  return runBlenderScript(script, request, options);
}

// src/index.ts
var SERVER_NAME = "threenative-blender-mcp";
var SERVER_VERSION = "0.1.5";
var AUTHORING_INSTRUCTIONS = "Call blender_status before anything else: it answers whether this machine can convert models at all, and when it cannot it names the install command rather than failing. Blender is never installed for the user \u2014 ask first, then let them run the command. An .fbx, .blend, .obj or .dae placed in a game's assets directory is converted by the build itself; these tools are for inspecting a source before committing it and for operations the build does not perform. For anything no named tool covers, read a shipped recipe with blender_recipes and adapt it, then run it with blender_run_python.";
var TOOL_DEFINITIONS = [
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "blender_status",
    description: "Report whether this machine has a supported Blender, where it is and what version. Never fails: when Blender is absent it returns available:false with the install command for each platform.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" }
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "blender_inspect",
    description: `Report what a model file contains without writing anything: mesh, triangle, vertex and bone counts, material names, animation clip names and image names. Accepts ${BLENDER_SOURCE_EXTENSIONS.join(", ")}, .gltf and .glb.`,
    inputSchema: {
      additionalProperties: false,
      properties: {
        source: { description: "Path to the model file to inspect.", type: "string" }
      },
      required: ["source"],
      type: "object"
    }
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    name: "blender_convert",
    description: "Convert a model file to a GLB a ThreeNative game can load, preserving skeletons, animation clips, materials and textures. A conversion that produces no meshes fails rather than writing an empty GLB. Note that a game's build converts these files itself: use this to check a source before committing it, or to write a GLB somewhere else.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        out: { description: "Path of the .glb to write.", type: "string" },
        source: { description: "Path to the model file to convert.", type: "string" }
      },
      required: ["source", "out"],
      type: "object"
    }
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    name: "blender_recipes",
    description: "List the shipped bpy recipes, read one's full source text, or run one. Read before you write: a working recipe adapted into your game beats bpy written cold. Omit 'name' to list; pass 'name' alone to read; pass 'name' with 'arguments' to run.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        arguments: {
          description: "Recipe arguments. Present means run it; absent means return its source.",
          type: "object"
        },
        name: { description: "Recipe name. Omit to list every recipe.", type: "string" }
      },
      type: "object"
    }
  },
  {
    annotations: { destructiveHint: true, openWorldHint: false, readOnlyHint: false },
    name: "blender_export_world",
    description: "Export a Blender-authored world as a ThreeNative world package v1: world.json, a raw uint16 heightmap, one GLB plus a decimated LOD1 per referenced scatter asset, per-cell chunk GLBs and placements.bin. Reads render-density instances so viewport share tricks never leak in; marks the terrain with tn_world_terrain, scatter sources with tn_asset_id and chunk collections with tn_world_chunk.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        cell: { description: "Cell edge length in metres.", type: "number" },
        out: { description: "Directory to write the package into.", type: "string" },
        source: { description: "Path to the .blend world to read.", type: "string" },
        spacing: {
          description: "Heightmap sample spacing in metres. Default 2.",
          type: "number"
        }
      },
      required: ["source", "out", "cell"],
      type: "object"
    }
  },
  {
    annotations: { destructiveHint: true, openWorldHint: false, readOnlyHint: false },
    name: "blender_run_python",
    description: "Run a bpy script of your own inside Blender, with a timeout, returning its result line, stderr and exit code. This is NOT a sandbox and does not claim to be: the script runs with your own privileges, exactly as it would if you invoked Blender through Bash yourself. What it adds is a resolved Blender, the same fail-closed handling every other tool here uses, and discoverability \u2014 not privilege. Read blender_recipes first; the shipped recipes are the worked examples.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        arguments: {
          description: "The JSON request handed to the script after '--'.",
          type: "object"
        },
        script: { description: "Path to the .py file to run inside Blender.", type: "string" },
        timeoutMs: { description: "Kill the run after this many milliseconds.", type: "number" }
      },
      required: ["script"],
      type: "object"
    }
  }
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonRpcError(id, code, message) {
  return JSON.stringify({ id, jsonrpc: "2.0", error: { code, message } });
}
function jsonRpcResult(id, result) {
  return JSON.stringify({ id, jsonrpc: "2.0", result });
}
function writeLine(value) {
  process.stdout.write(`${value}
`);
}
function toolText(value) {
  return { content: [{ text: JSON.stringify(value, null, 2), type: "text" }] };
}
function blenderStatusResult(status = resolveBlender()) {
  return {
    available: status.available,
    ...status.cause === void 0 ? {} : { cause: status.cause },
    detail: status.detail,
    install: status.install,
    installCommand: installCommandFor(),
    minimumVersion: status.minimumVersion,
    ...status.path === void 0 ? {} : { path: status.path },
    ...status.version === void 0 ? {} : { version: status.version }
  };
}
function requiredString(argumentsValue, key, tool) {
  const value = argumentsValue[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${tool} requires a non-empty string '${key}' argument.`);
  }
  return value;
}
async function handleRecipes(argumentsValue) {
  if (argumentsValue.name === void 0) {
    return {
      recipes: RECIPES.map((recipe2) => ({
        description: recipe2.description,
        name: recipe2.name,
        parameters: recipe2.parameters,
        script: recipePath(recipe2)
      }))
    };
  }
  const recipe = findRecipe(argumentsValue.name);
  if (argumentsValue.arguments === void 0) {
    return {
      description: recipe.description,
      name: recipe.name,
      parameters: recipe.parameters,
      script: recipePath(recipe),
      source: recipeSource(recipe)
    };
  }
  if (!isRecord(argumentsValue.arguments)) {
    throw new Error("blender_recipes 'arguments' must be an object.");
  }
  return runRecipe(recipe.name, argumentsValue.arguments);
}
async function handleToolCall(params) {
  const name = params.name;
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  if (name === "blender_status") return toolText(blenderStatusResult());
  if (name === "blender_inspect") {
    const source = requiredString(argumentsValue, "source", "blender_inspect");
    return toolText(await inspectModel(source));
  }
  if (name === "blender_convert") {
    const source = requiredString(argumentsValue, "source", "blender_convert");
    const out = requiredString(argumentsValue, "out", "blender_convert");
    return toolText(await convertModel(source, out));
  }
  if (name === "blender_recipes") return toolText(await handleRecipes(argumentsValue));
  if (name === "blender_export_world") {
    const source = requiredString(argumentsValue, "source", "blender_export_world");
    const out = requiredString(argumentsValue, "out", "blender_export_world");
    const cell = argumentsValue.cell;
    if (typeof cell !== "number" || !Number.isFinite(cell) || cell <= 0) {
      throw new Error("blender_export_world 'cell' must be a number greater than zero.");
    }
    const spacing = argumentsValue.spacing;
    if (spacing !== void 0 && (typeof spacing !== "number" || !Number.isFinite(spacing) || spacing <= 0)) {
      throw new Error("blender_export_world 'spacing' must be a number greater than zero.");
    }
    return toolText(
      await runRecipe("export_world", {
        cell,
        out,
        source,
        ...spacing === void 0 ? {} : { spacing }
      })
    );
  }
  if (name === "blender_run_python") {
    const script = requiredString(argumentsValue, "script", "blender_run_python");
    const request = argumentsValue.arguments === void 0 ? {} : argumentsValue.arguments;
    if (!isRecord(request)) throw new Error("blender_run_python 'arguments' must be an object.");
    const timeoutMs = argumentsValue.timeoutMs;
    if (timeoutMs !== void 0 && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(
        "blender_run_python 'timeoutMs' must be a positive whole number of milliseconds."
      );
    }
    return toolText(
      await runBlenderScript(script, request, timeoutMs === void 0 ? {} : { timeoutMs })
    );
  }
  throw new Error(`Unknown blender MCP tool '${String(name)}'.`);
}
async function handleLine(line) {
  if (line.trim().length === 0) return void 0;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return jsonRpcError(null, -32700, `Invalid JSON: ${String(error)}`);
  }
  if (!isRecord(request) || request.id === void 0 || typeof request.method !== "string")
    return void 0;
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        capabilities: { tools: { listChanged: false } },
        instructions: AUTHORING_INSTRUCTIONS,
        protocolVersion: "2025-06-18",
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS });
    }
    if (request.method === "tools/call") {
      if (!isRecord(request.params)) throw new Error("tools/call requires an object params value.");
      return jsonRpcResult(request.id, await handleToolCall(request.params));
    }
    return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return jsonRpcError(request.id, -32e3, error instanceof Error ? error.message : String(error));
  }
}
function runServer() {
  const input = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  input.on("line", (line) => {
    queue = queue.then(async () => {
      const response = await handleLine(line);
      if (response !== void 0) writeLine(response);
    });
  });
}
var entryPath = process.argv[1];
if (entryPath !== void 0 && realpathSync(path2.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  runServer();
}

export { TOOL_DEFINITIONS, blenderStatusResult, handleLine, handleToolCall, runServer };
