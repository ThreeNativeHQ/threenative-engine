/**
 * Records the pinned reference's answer to every fixture, in Node, without a browser.
 *
 *   pnpm --filter @threenative/three-native test:reference
 *   pnpm --filter @threenative/three-native test:reference -- --repeat 2
 *   pnpm --filter @threenative/three-native test:reference -- --check
 *   pnpm --filter @threenative/three-native test:reference -- --check --no-renders
 *
 * Goldens land in `goldens/<three version>/<fixture>.json`, keyed by the workspace catalog pin so
 * a reference upgrade lands new files instead of silently overwriting old ones. `--check` proves
 * the committed goldens are what this reference produces today; `--repeat N` proves two runs of
 * the same corpus agree, which is what makes a golden usable as an oracle at all.
 *
 * A render fixture adds one frame. Its numbers still come from Node, and its `pixels` observation
 * comes from `render-reference.ts`: one headed WebGPU Chromium draws it and writes the PNG beside
 * the JSON golden. That run needs a display and a real adapter, so on Linux it goes under
 * `sh scripts/xvfb.sh`. A software adapter is refused rather than recorded; `--allow-software`
 * overrides that, and the adapter is named in the golden either way.
 *
 * `--no-renders` drops the render fixtures and needs no GPU, so CI can run it; the output counts
 * what it skipped (`skippedRenders`). The full check with frames stays a local gate.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FIXTURES_DIR,
  type FixtureArg,
  type IFixture,
  type IFixtureGolden,
  type IGoldenObservation,
  REPO_ROOT,
  goldenPath,
  loadFixtures,
  pinnedThreeVersion,
  renderPngPath,
  writeGolden,
  writeRenderPng,
} from "../../src/fixture-format.js";
import { encodeObservation, namedNumber } from "../../src/fixture-protocol.js";
import { type IRenderCapture, captureRenderFixtures } from "./render-reference.js";

/**
 * three's GLTFLoader on a repository file, its default scene. Node has no DOM to decode images, so
 * a texture stands in for each glTF texture; observations here never read pixels.
 */
async function loadGltf(
  threeRoot: string,
  file: string,
): Promise<{ scene: unknown; animations: unknown[] }> {
  const loaderUrl = pathToFileURL(
    path.join(threeRoot, "examples", "jsm", "loaders", "GLTFLoader.js"),
  ).href;
  const { GLTFLoader } = (await import(loaderUrl)) as {
    GLTFLoader: new () => {
      register(plugin: (parser: { json: { textures: { name?: string }[] } }) => unknown): void;
      parseAsync(
        data: ArrayBuffer,
        path: string,
      ): Promise<{ scene: unknown; animations: unknown[] }>;
    };
  };
  const three = (await import(
    pathToFileURL(path.join(threeRoot, "build", "three.module.js")).href
  )) as {
    Texture: new () => { name: string };
  };
  const loader = new GLTFLoader();
  // A plugin takes its name's slot, so the stand-in also replaces the WebP extension's loader,
  // which runs before any plugin registered later and would decode the image.
  for (const name of ["tn_no_image_decode", "EXT_texture_webp"])
    loader.register((parser) => ({
      name,
      loadTexture(index: number) {
        const texture = new three.Texture();
        texture.name = parser.json.textures[index]?.name ?? "";
        return Promise.resolve(texture);
      },
    }));
  const bytes = readFileSync(path.join(REPO_ROOT, file));
  const gltf = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  return gltf;
}

/** The pinned `three`, from whichever package in the workspace links the same store copy. */
async function loadReference(): Promise<{
  readonly three: Record<string, unknown>;
  readonly version: string;
  readonly root: string;
}> {
  const expected = pinnedThreeVersion(REPO_ROOT);
  for (const owner of ["three-native", "runtime-native", "core"]) {
    const require = createRequire(path.join(REPO_ROOT, "packages", owner, "package.json"));
    let entry: string;
    try {
      entry = require.resolve("three");
    } catch {
      continue;
    }
    const build = path.dirname(entry);
    const manifest = JSON.parse(readFileSync(path.join(build, "..", "package.json"), "utf8")) as {
      version: string;
    };
    if (manifest.version !== expected)
      throw new Error(
        `TN_FIXTURE_THREE_MISMATCH: packages/${owner} links three ${manifest.version}, the workspace catalog pins ${expected}`,
      );
    const core = (await import(pathToFileURL(path.join(build, "three.module.js")).href)) as Record<
      string,
      unknown
    >;
    // The node materials are `three/webgpu` exports; both builds share three.core.js, so the core
    // classes are the same constructors in either namespace.
    const webgpu = (await import(
      pathToFileURL(path.join(build, "three.webgpu.js")).href
    )) as Record<string, unknown>;
    // The addons a fixture constructs by class name, over the same core module.
    const { RoundedBoxGeometry } = (await import(
      pathToFileURL(
        path.join(build, "..", "examples", "jsm", "geometries", "RoundedBoxGeometry.js"),
      ).href
    )) as Record<string, unknown>;
    const three = { ...webgpu, ...core, RoundedBoxGeometry };
    return { three, version: manifest.version, root: path.join(build, "..") };
  }
  throw new Error("TN_FIXTURE_THREE_MISSING: no workspace package links the catalog three");
}

/** Turns one fixture argument into the value the reference method receives. */
function argument(arg: FixtureArg, bound: ReadonlyMap<string, unknown>): unknown {
  if (arg !== null && typeof arg === "object") {
    if ("ref" in arg) {
      const found = bound.get(arg.ref);
      if (found === undefined) throw new Error(`TN_FIXTURE_UNBOUND: ${arg.ref} has no value`);
      return found;
    }
    if ("refs" in arg) return arg.refs.map((id) => argument({ ref: id }, bound));
    if ("record" in arg) return { ...arg.record };
    if ("array" in arg) return new globalThis[arg.type](arg.array);
    return namedNumber(arg.num);
  }
  return arg;
}

function readPath(root: unknown, dotted: string): unknown {
  let current = root;
  for (const segment of dotted.split(".")) {
    if (current === null || current === undefined)
      throw new Error(`TN_FIXTURE_PATH_MISSING: ${dotted} leaves ${String(current)}`);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(root: unknown, dotted: string, value: unknown): void {
  const segments = dotted.split(".");
  const last = segments.pop();
  if (last === undefined) throw new Error(`TN_FIXTURE_PATH_INVALID: ${dotted}`);
  let current = root as Record<string, unknown>;
  for (const segment of segments) {
    const next = current[segment];
    if (next === null || next === undefined)
      throw new Error(`TN_FIXTURE_PATH_MISSING: ${dotted} leaves ${String(next)}`);
    current = next as Record<string, unknown>;
  }
  current[last] = value;
}

/**
 * The fixture's golden. `captures` holds the frames a browser drew for its render fixtures.
 *
 * A `pixels` observation is the one observation no Node object can answer: its value is the hash
 * of the captured frame, so a fixture that asks for one and got no capture is an error, not a
 * golden with a hole in it.
 */
export async function referenceGolden(
  fixture: IFixture,
  captures: ReadonlyMap<string, IRenderCapture> = new Map(),
): Promise<IFixtureGolden> {
  const { three, version, root } = await loadReference();
  const bound = new Map<string, unknown>();
  for (const op of fixture.ops) {
    // A TSL program changes only what the frame draws, which the browser capture records.
    if (op.op === "tsl") continue;
    if (op.op === "gltf") {
      const gltf = await loadGltf(root, op.file);
      bound.set(op.id, gltf.scene);
      op.clips?.forEach((clip, i) => bound.set(clip, gltf.animations[i]));
      continue;
    }
    if (op.op === "new") {
      const Constructor = three[op.class];
      // `MathUtils` is a namespace object, not a constructor: bind it as the one object three exports,
      // so a `call` reaches its stateless functions as a game does. Everything else is constructible.
      if (
        typeof Constructor !== "function" &&
        typeof Constructor === "object" &&
        Constructor !== null
      ) {
        bound.set(op.id, Constructor);
        continue;
      }
      if (typeof Constructor !== "function")
        throw new Error(
          `TN_FIXTURE_CLASS_UNKNOWN: ${op.class} is not exported by three ${version}`,
        );
      bound.set(
        op.id,
        new (Constructor as new (...args: unknown[]) => unknown)(
          ...op.args.map((arg) => argument(arg, bound)),
        ),
      );
      continue;
    }
    const target = bound.get(op.id);
    if (target === undefined) throw new Error(`TN_FIXTURE_UNBOUND: ${op.id} has no value`);
    const holder = target as Record<string, unknown>;
    if (op.op === "set") {
      writePath(target, op.path, argument(op.value, bound));
      continue;
    }
    const method = holder[op.method];
    if (typeof method !== "function") {
      // A member object (`Object3D.position`) is not callable: with no arguments it is read as the
      // property itself, which three allocates once, so a caller keeps the same object and sees
      // writes through it. This is the reference half of the native driver's `members` map, whose
      // Ref is the one identity of that member (§6.1).
      if (op.args.length === 0 && typeof method === "object" && method !== null) {
        if (op.result !== undefined) bound.set(op.result, method);
        continue;
      }
      throw new Error(`TN_FIXTURE_METHOD_UNKNOWN: ${op.id}.${op.method} is not callable`);
    }
    const returned = (method as (...args: unknown[]) => unknown).apply(
      target,
      op.args.map((arg) => argument(arg, bound)),
    );
    if (op.result !== undefined) bound.set(op.result, returned);
  }

  const observations: IGoldenObservation[] = fixture.observe.map((observation, index) => {
    if (observation.kind === "pixels") {
      const capture = captures.get(fixture.name);
      if (capture === undefined)
        throw new Error(
          `TN_FIXTURE_RENDER_NOT_CAPTURED: ${fixture.name} asks for pixels and no browser frame arrived`,
        );
      const encoded = encodeObservation("pixels", capture.pngSha256);
      return {
        index,
        id: observation.id,
        kind: observation.kind,
        value: encoded.value,
        decimal: encoded.decimal,
      };
    }
    const target = bound.get(observation.id);
    if (target === undefined) throw new Error(`TN_FIXTURE_UNBOUND: ${observation.id} has no value`);
    const holder = target as Record<string, unknown>;
    const value =
      observation.path !== undefined
        ? readPath(target, observation.path)
        : observation.method === undefined
          ? target
          : (() => {
              const method = holder[observation.method];
              if (typeof method !== "function")
                throw new Error(
                  `TN_FIXTURE_METHOD_UNKNOWN: ${observation.id}.${observation.method} is not callable`,
                );
              return (method as () => unknown).call(target);
            })();
    if (value === undefined)
      throw new Error(
        `TN_FIXTURE_PATH_MISSING: observation ${index} read ${observation.path ?? observation.method ?? "the bound value"} as undefined`,
      );
    const encoded = encodeObservation(observation.kind, value);
    return {
      index,
      id: observation.id,
      kind: observation.kind,
      ...(observation.path === undefined ? {} : { path: observation.path }),
      ...(observation.method === undefined ? {} : { method: observation.method }),
      value: encoded.value,
      decimal: encoded.decimal,
    };
  });
  const render = fixture.render;
  const capture = render === undefined ? undefined : captures.get(fixture.name);
  if (render !== undefined && capture === undefined)
    throw new Error(`TN_FIXTURE_RENDER_NOT_CAPTURED: ${fixture.name} renders but no frame arrived`);
  return {
    name: fixture.name,
    threeVersion: version,
    adaptedFrom: fixture.adaptedFrom,
    blocked: null,
    observations,
    ...(capture === undefined
      ? {}
      : {
          render: {
            png: `${fixture.name}.png`,
            pngSha256: capture.pngSha256,
            width: capture.width,
            height: capture.height,
            adapter: capture.adapter,
          },
        }),
  };
}

/** One pass over the corpus: every fixture's golden, with the browser frames this pass drew. */
async function pass(
  fixtures: readonly IFixture[],
  options: { readonly allowSoftware: boolean },
): Promise<{
  readonly goldens: readonly IFixtureGolden[];
  readonly captures: ReadonlyMap<string, IRenderCapture>;
}> {
  const renders = fixtures.filter((fixture) => fixture.render !== undefined);
  const captures = await captureRenderFixtures(renders, { allowSoftware: options.allowSoftware });
  return {
    goldens: await Promise.all(fixtures.map((fixture) => referenceGolden(fixture, captures))),
    captures,
  };
}

/** The run itself: one pass over the corpus. `--repeat` and `--check` wrap this. */
async function main(argv: readonly string[]): Promise<number> {
  const repeat = Number(valueAfter(argv, "--repeat") ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error("TN_FIXTURE_ARG_INVALID: --repeat needs a positive integer");
  const check = argv.includes("--check");
  const allowSoftware = argv.includes("--allow-software");
  const selected = selectFixtures(argv);
  const noRenders = argv.includes("--no-renders");
  const fixtures = noRenders
    ? selected.filter((fixture) => fixture.render === undefined)
    : selected;
  const skippedRenders = selected.length - fixtures.length;
  // Fail closed: an empty run would report a clean check for a corpus it never touched.
  if (fixtures.length === 0)
    throw new Error("TN_FIXTURE_SELECTION_EMPTY: --no-renders left no fixture to run");
  // A diagnostic invocation must never regenerate the pinned goldens.
  if (process.env.TN_TRAA_DUMP) {
    if (fixtures.length !== 1 || fixtures[0]?.name !== "traa-history")
      throw new Error("TN_TRAA_DUMP requires --only traa-history");
    await captureRenderFixtures(fixtures, { allowSoftware });
    process.stdout.write(`TRAA dump: ${path.resolve(process.env.TN_TRAA_DUMP)}\n`);
    return 0;
  }
  const version = pinnedThreeVersion(REPO_ROOT);

  let run = await pass(fixtures, { allowSoftware });
  for (let round = 2; round <= repeat; round += 1) {
    const again = await pass(fixtures, { allowSoftware });
    again.goldens.forEach((golden, index) => {
      if (JSON.stringify(golden) !== JSON.stringify(run.goldens[index]))
        throw new Error(
          `TN_FIXTURE_NOT_REPRODUCIBLE: ${golden.name} differs between run 1 and run ${round}`,
        );
    });
    run = again;
  }
  const goldens = run.goldens;

  const problems: string[] = [];
  for (const golden of goldens) {
    const file = path.join("tests", "compatibility", "goldens", version, `${golden.name}.json`);
    if (check) {
      const committed = goldenPath(golden.name, version);
      const actual = existsSync(committed) ? readFileSync(committed, "utf8") : null;
      const regenerated = `${JSON.stringify(golden, null, 2)}\n`;
      if (actual !== regenerated)
        problems.push(
          `${file}: ${actual === null ? "missing" : "differs from the regenerated golden"}`,
        );
      // The PNG is the observation; a JSON golden whose frame is missing or stale asserts nothing.
      const png = renderPngPath(golden.name, version);
      if (golden.render === undefined) {
        if (existsSync(png)) problems.push(`${png}: a frame with no pixels observation is stale`);
        continue;
      }
      const captured = existsSync(png)
        ? createHash("sha256").update(readFileSync(png)).digest("hex")
        : null;
      if (captured !== golden.render.pngSha256)
        problems.push(
          `${png}: ${captured === null ? "missing" : `hashes ${captured}, the golden records ${golden.render.pngSha256}`}`,
        );
      continue;
    }
    process.stdout.write(`${writeGolden(golden, version)}\n`);
    const capture = run.captures.get(golden.name);
    if (capture !== undefined)
      process.stdout.write(`${writeRenderPng(golden.name, version, capture.png)}\n`);
  }

  const blocked = goldens.filter((golden) => golden.blocked !== null);
  const renders = goldens.flatMap((golden) =>
    golden.render === undefined
      ? []
      : [
          {
            name: golden.name,
            png: golden.render.png,
            pngSha256: golden.render.pngSha256,
            adapter: golden.render.adapter,
          },
        ],
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        threeVersion: version,
        fixtures: goldens.length,
        observations: goldens.reduce((total, golden) => total + golden.observations.length, 0),
        blocked: blocked.map((golden) => ({ name: golden.name, reason: golden.blocked })),
        renders,
        repeats: repeat,
        ...(noRenders ? { skippedRenders } : {}),
        ...(check ? { checked: true } : { wrote: goldens.length }),
        ...(problems.length === 0 ? {} : { problems }),
      },
      null,
      2,
    )}\n`,
  );
  return problems.length === 0 ? 0 : 1;
}

/**
 * `--only` takes globs over fixture names (`math-core-*`), comma-separated for several
 * (`lit-render,materials-*`), so a ctest case can run part of the corpus without the rest. Only `*`
 * and `?` are wildcards; every other character is the name's own, because a fixture name is an
 * identifier and a regex metacharacter in one is a typo.
 */
function fixturePattern(globs: string): RegExp {
  const alternatives = globs.split(",").map((glob) =>
    glob
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\\\*/gu, ".*")
      .replace(/\\\?/gu, "."),
  );
  return new RegExp(`^(?:${alternatives.join("|")})$`, "u");
}

/** The fixtures `--only` selects, or every fixture. A glob that selects nothing is an error. */
function selectFixtures(argv: readonly string[]): readonly IFixture[] {
  const fixtures = loadFixtures(FIXTURES_DIR);
  const only = valueAfter(argv, "--only");
  if (only === null) return fixtures;
  const pattern = fixturePattern(only);
  const selected = fixtures.filter((fixture) => pattern.test(fixture.name));
  // Fail closed: an empty run would report a clean summary for a corpus it never touched.
  if (selected.length === 0)
    throw new Error(`TN_FIXTURE_SELECTION_EMPTY: --only ${only} matched none`);
  return selected;
}

function valueAfter(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** Only the CLI owns the exit code; a spec that imports `referenceGolden` must not run a pass. */
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
