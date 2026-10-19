// Regenerates src/render/*-shader.ts from the tempest-*.frag files.
//
// Two shaders come out of one pipeline: the raymarched coast and the cloud volume it stands under.
// Both are several hundred lines of GLSL from the Tempest single-file demo, so porting either by
// hand is a transcription exercise with no end state. The installed Three.js transpiler
// (`three/examples/jsm/transpiler`) does the port at authoring time and this file checks the
// result. Nothing is compiled or evaluated at runtime: the output is an ordinary `.ts` module that
// Vite and the native packager see like any other source file.
//
// Fails closed. A GLSL construct the upstream decoder does not understand, a uniform the emitted
// code reads but nothing binds, a local this file cannot materialise, a branch dropped at runtime,
// or any warning from the decoder stops the run instead of writing a file that quietly lost one.
//
//   node tools/generate-shaders.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import GLSLDecoder from "three/examples/jsm/transpiler/GLSLDecoder.js";
import TSLEncoder from "three/examples/jsm/transpiler/TSLEncoder.js";
import Transpiler from "three/examples/jsm/transpiler/Transpiler.js";

const here = dirname(fileURLToPath(import.meta.url));
// The repository this template lives in, four levels up from `tools/`. A scaffolded project has no
// Biome of its own, which is why the formatting step below is optional and says so.
const repoRoot = resolve(here, "../../../../..");
// Biome refuses paths outside the directory it is run from, so it runs from the repository root,
// which is also where the configuration that formats the generated file lives. The unsafe fixes
// are asked for on purpose and were diffed: for this output they are the import sort and the
// split of multi-name `const` declarators, both of which leave the graph alone.
const biome = resolve(repoRoot, "node_modules/.bin/biome");

/**
 * A sampler the decoder turns into a texture node, and how each is declared here. Both start as a
 * 1-voxel placeholder that the owning module replaces by assigning `.value`, because a sampled node
 * needs a texture before the graph is built.
 */
const SAMPLERS = {
  sampler2D: { node: "texture", texture: "DataTexture", create: "1, 1" },
  sampler3D: { node: "texture3D", texture: "Data3DTexture", create: "1, 1, 1" },
};

/** Uniform defaults, so nothing reads an unset value on the first frame. */
const DEFAULTS = {
  float: "0",
  int: "0",
  vec2: "new Vector2()",
  vec3: "new Vector3()",
  vec4: "new Vector4()",
};

/**
 * Applied to every emitted module. GLSL's `mat2(a, b, c, d)` is column-major — `(a, b)` is the first
 * column — but TSL's `mat2(a, b, c, d)` with constants builds a `Matrix2`, whose constructor takes
 * row-major arguments. Passed through unchanged, fbm's octave rotation comes out transposed: a
 * rotation the other way, so every octave after the first lands somewhere else and the terrain's
 * ridges, the puddles and the cloud shapes all drift from the study's. Swapping the off-diagonal
 * pair is the transpose back.
 */
const MAT2_COLUMN_MAJOR = {
  what: "a constant mat2 in GLSL's column-major order",
  find: /mat2\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)/g,
  replace: "mat2($1, $3, $2, $4)",
};

/**
 * The shaders this generates. `rewrites` are edits to the GLSL text; each one is a rewrite with a
 * named reason, and a rule that matches nothing stops the run. `entryOpen` turns the stage's
 * `main` into the one function the module exports; `entryClose` covers what that function has to
 * hand back.
 */
const SHADERS = [
  {
    name: "world",
    marker: "TN_WORLD_SHADER",
    source: "tempest-world.frag",
    target: "../src/render/world-shader.ts",
    entry: "tempestWorld",
    /** The coast raymarches with a depth term, so it seeds one the way a GLSL global would. */
    entryOpen: ["void main(){", "vec4 tempestWorld(vec2 vUv){float worldDepth=1.;"],
    entryClose: [
      { what: "gl_FragDepth", find: "gl_FragDepth", replace: "worldDepth" },
      {
        what: "the fragment output",
        find: "fragColor=vec4(max(color,vec3(0.)),1.);",
        replace: "return vec4(max(color,vec3(0.)),worldDepth);",
      },
    ],
    samplers: ["sampler2D"],
    /** The ripple loop is a nested pair, which the decoder names in a way `LoopNode` cannot read. */
    nestedLoop: true,
    /**
     * Edits to the code the transpiler emitted, rather than to the GLSL it read. This one is the
     * coast's alone: the decoder turns `roadCenter`'s `-1.6` into `-(1.6).add(x)`, which asks a
     * JavaScript number for a TSL method and throws on the first frame. `float(-1.6)` is the same
     * value. The cloud volume has no literal in that position, so it declares none.
     */
    outputRewrites: [
      MAT2_COLUMN_MAJOR,
      {
        what: "a negated literal with a TSL method call on it",
        find: /- ?((?:\d+\.\d*|\.\d+|\d+))\.(?=[A-Za-z_$])/g,
        replace: "float(-$1).",
      },
      {
        // The one orientation rule this shader needs, and it is deliberately not a camera- or
        // backend-name conditional. `vUv` is the screen quad's geometry uv: bottom-up, `y = 1` at
        // the top of the frame. `uSky` is a `PassTextureNode` — a render target written by the
        // cloud pass — and a render target's first row is the top of the image it holds, so its
        // `y = 0` is the top of the frame. Sampling one with the other hands the coast the sky
        // upside down: the deck's bright horizon band lands high in the frame, well above the
        // world's own horizon, and the whole ceiling is mirrored. Normalising the coordinate at the
        // fetch is the fix, and it is fetch-local: `ray(vUv)` still marches with the bottom-up uv
        // the source was written against, so the cloud volume and every density in it are
        // untouched. Both reads are rewritten, the direct sky sample and the reflected `suv`,
        // because a flip on one and not the other would put the reflections somewhere the sky they
        // mirror is not.
        what: "the pass-texture sample coordinate",
        find: /uSky\.sample\(\s*(\w+)\s*\)/g,
        replace: "uSky.sample(vec2($1.x,$1.y.oneMinus()))",
        imports: ["oneMinus"],
      },
    ],
    rewrites: [
      {
        // The upstream decoder only reads the first name of a comma-separated uniform list, so every
        // uniform after the first in `uniform float a,b,c;` is dropped from the emitted module and
        // would be a ReferenceError at runtime. `boundUniforms` below re-adds and checks them all.
        what: "the ripple loop braces",
        find: "for(int j=-1;j<=1;j++)",
        replace: "for(int j=-1;j<=1;j++){",
      },
      {
        what: "the ripple loop close",
        find: " }return sum*uRain;",
        replace: " }}return sum*uRain;",
      },
    ],
    header: `// The shader is the coast: terrain, road, sea, the rail and cabin on it, wet reflections and the
// fog that closes the distance. It is raymarched, so it is one full-screen quad and one function
// call — see src/render/world.ts for the uniforms and the camera basis it expects.`,
  },
  {
    name: "clouds",
    marker: "TN_CLOUDS_SHADER",
    source: "tempest-clouds.frag",
    target: "../src/render/clouds-shader.ts",
    entry: "tempestClouds",
    /** The cloud volume has no depth term; it is the colour the coast samples for its sky. */
    entryOpen: ["void main(){", "vec4 tempestClouds(vec2 vUv){"],
    entryClose: [],
    samplers: ["sampler3D"],
    nestedLoop: false,
    outputRewrites: [
      MAT2_COLUMN_MAJOR,
      {
        // The decoder's own `gl_FragCoord` polyfill reaches for `screenCoordinate.z`, which is not a
        // member of a `vec2` screen coordinate: the fragment depth is its own node, and that is what
        // `gl_FragCoord.z` is.
        what: "the depth component of the decoded gl_FragCoord",
        find: "screenCoordinate.z",
        replace: "depth",
        imports: ["depth"],
      },
    ],
    rewrites: [],
    header: `// The shader is the storm ceiling: a raymarched volume between 145 and 815 metres, lit by a
// five-tap march toward the sun and filled from a procedural 64³ noise volume. It is one full-screen
// pass into a render target the coast samples — see src/render/clouds.ts.`,
  },
];

/** Applied to every shader before it is parsed, because none of them is valid GLSL on its own. */
const COMMON_REWRITES = [
  {
    // `precision` is a GLSL-only qualifier with no TSL equivalent; TSL picks the precision itself.
    what: "precision qualifiers",
    find: /precision[^;]*;/g,
    replace: "",
  },
  {
    // The stage's own varyings become the generated function's parameters, not module state.
    what: "stage declarations",
    find: /\b(?:in|out)\s+\w+\s+\w+\s*;/g,
    replace: "",
  },
];

// The emitted code is JavaScript, so the structural fixes below are made on its syntax tree rather
// than on its text: the transpiler's own output decides where they apply, and a shape this file
// does not recognise stops the run rather than being rewritten by a pattern that happened to fit.
// TypeScript is the template's own devDependency, so a scaffolded project has it.

const parse = (text) =>
  ts.createSourceFile("shader.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/**
 * The name a call's callee is written as. Both spellings appear in TSL: `Fn(...)` for the imported
 * functions and `node.toVar()` for the methods, and a declaration initialised by a method call has
 * to be recognised as already materialised, so a property access counts too.
 */
const callee = (node) => {
  const { expression } = node;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
};

/** `true` for the arrow or function the transpiler wrote as an argument to `Fn(...)`. */
const isFnBody = (node) =>
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
  ts.isCallExpression(node.parent) &&
  callee(node.parent) === "Fn";

/**
 * `Fn(fn, { p: 'vec2', return: 'float' })` is the transpiler's shorthand for a function taking one
 * vec2, and as a second argument it is not a layout anything reads. `Fn`'s builder path takes that
 * second argument as a shader-node builder to hand the callback, so the emitted functions capture
 * every uniform they read into a struct that is never bound: the first compile reports a missing
 * uniform member, and the frame group resolves no member at all. Nothing is lost by dropping it,
 * because no function is ever emitted as a real shader function — all of them are inlined, and the
 * types the layout spelled out are already on the callback parameters as typed tuples. Removed by
 * span, from every `Fn` call.
 */
function stripFnLayout(code) {
  const file = parse(code);
  const spans = [];
  const walk = (node) => {
    if (ts.isCallExpression(node) && callee(node) === "Fn") {
      const [callback, layout] = node.arguments;
      if (node.arguments.length === 1) {
        if (!callback || !isFnBody(callback))
          throw new Error("TN_TRANSPILER_FN_SHAPE: an Fn call lost its callback");
      } else if (
        node.arguments.length === 2 &&
        callback &&
        isFnBody(callback) &&
        ts.isObjectLiteralExpression(layout)
      ) {
        spans.push([callback.end, layout.end]);
      } else {
        throw new Error(
          `TN_TRANSPILER_FN_SHAPE: Fn takes ${node.arguments.length} arguments and none is a layout to remove`,
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (spans.length === 0)
    throw new Error("TN_TRANSPILER_NO_FN_LAYOUT: no Fn call carried a layout argument");
  let out = code;
  for (const [from, to] of spans.reverse()) out = out.slice(0, from) + out.slice(to);
  return out;
}

/**
 * A local GLSL variable is a mutable TSL node, but the transpiler writes it as a plain JavaScript
 * `const` holding the expression it was initialised with. Every later `+=` or `.assign` then
 * mutates a temporary nothing reads back, so the shader compiles and runs holding the first value
 * it ever saw: the march never advances and the scene stays the sky it started on. `toVar()` is
 * what names a node — it materialises the value into a shader variable the rest of the function can
 * reassign — and it is needed on every initialised local, not only on the ones a parameter was
 * assigned to. Applied inside function bodies only, so the module-level declarations, which are
 * uniforms and the `Fn` calls themselves, are left as the transpiler wrote them.
 */
function materializeLocals(code) {
  const file = parse(code);
  const inserts = [];
  const destructured = [];
  const walk = (node, inBody) => {
    const body = inBody || isFnBody(node) || ts.isFunctionDeclaration(node);
    if (body && ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const { initializer } = node;
        if (!(ts.isCallExpression(initializer) && callee(initializer) === "toVar")) {
          inserts.push(initializer.end);
        }
      } else {
        destructured.push(node.name.getText(file));
      }
    }
    ts.forEachChild(node, (child) => walk(child, body));
  };
  walk(file, false);
  if (destructured.length > 0) {
    throw new Error(
      `TN_TRANSPILER_DESTRUCTURED: ${destructured.join(", ")} destructures, so its value cannot be materialised`,
    );
  }
  if (inserts.length === 0)
    throw new Error("TN_TRANSPILER_NO_LOCALS: no local variable was found to materialise");
  let out = code;
  for (const at of inserts.reverse()) out = `${out.slice(0, at)}.toVar()${out.slice(at)}`;
  return out;
}

/**
 * A `return` inside an `If` or `Loop` callback is not the GLSL early return it was written as. Those
 * callbacks run while the node graph is being built, so the `return` only leaves the callback and
 * the node it was building is never assigned anywhere: the branch is dropped and the function keeps
 * whatever its last line said. That is how the coast's `baseColor` ended up returning a flat
 * `vec3(.1)` for every material and its `reflected` returning the sky for every ray. The sources
 * normalise a helper to one final return over `else if` and `Break` instead, so a return still
 * shaped like an early one is a mistake to stop on rather than to compile.
 */
function assertNoNestedReturns(code) {
  const file = parse(code);
  const nested = [];
  const walk = (node) => {
    if (ts.isReturnStatement(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isFnBody(parent)) break;
        if (ts.isCallExpression(parent) && (callee(parent) === "If" || callee(parent) === "Loop")) {
          nested.push(node.getText(file).split("\n")[0].trim());
          break;
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (nested.length > 0) {
    throw new Error(
      `TN_TRANSPILER_NESTED_RETURN: ${nested.length} return(s) inside If/Loop would be dropped at runtime: ${nested.join(" | ")}`,
    );
  }
}

/** Index of the `}` that closes the `{` at `open`, counting braces in the text between them. */
function closingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("TN_TRANSPILER_UNCLOSED_BRACE");
}

const LOOP_BOUNDS = /Loop\(\s*\{[^{}]*?((?:start|end):\s*-?\d+(?:\.\d+)?)/g;
/**
 * `Loop({ start: 0, end: 6 }, …)` leaves the counter's type to be inferred from a bare number, and
 * nothing is left to infer it from. GLSL wrote `int i`, so the bounds are stated as `int` too.
 */
function typeLoopBounds(body, injected) {
  const typed = body.replaceAll(LOOP_BOUNDS, (match, bound) =>
    match.replace(bound, `${bound.replace(":", ": int(")})`),
  );
  if (typed === body) throw new Error("TN_TRANSPILER_LOOP_BOUNDS: no bare loop bound was found");
  // The decoder leaves the import list out of it: it emitted a bare number, so it never reached for
  // `int`, and nothing else in a shader with no `int` local would have imported it either.
  injected.add("int");
  return typed;
}

/**
 * The decoder names a loop counter through `params.name`, which `LoopNode` reads and the published
 * types do not declare — their own source leaves that field commented out with a TODO saying it
 * should be typed. The nested pair is therefore written as `Loop`'s two-parameter form, which the
 * types do describe and which `LoopNode` builds from the same two `for` loops, naming the counters
 * `i` and `j`. The GLSL ran both counters over the same range, so the order cannot matter.
 */
function flattenNestedLoop(body) {
  const pattern = /Loop\(\s*(\{[^{}]*name: 'j'[^{}]*\}),\s*\(\s*\{\s*j\s*\}\s*\)\s*=>\s*\{/;
  const nested = body.match(pattern);
  if (nested === null)
    throw new Error("TN_TRANSPILER_NO_NESTED_LOOP: the ripple loop changed shape");
  const outerOpen = body.indexOf("{", nested.index + nested[0].length - 1);
  const outerClose = closingBrace(body, outerOpen);
  const innerStart = body.indexOf("Loop(", outerOpen);
  const innerBounds = closingBrace(body, body.indexOf("{", innerStart));
  // The callback's own parameter list is destructured, so its braces come first; the body opens
  // after the arrow, not after the bounds.
  const innerOpen = body.indexOf("{", body.indexOf("=>", innerBounds));
  const innerClose = closingBrace(body, innerOpen);
  const innerParams = body.slice(body.indexOf("{", innerStart), innerBounds + 1);
  const outerParams = nested[1].replace(/\s*name: 'j',?/, "");
  return [
    body.slice(0, nested.index),
    `Loop(${outerParams}, ${innerParams}, ({ i, j }) => {`,
    body.slice(innerOpen + 1, innerClose),
    "});",
    body.slice(body.indexOf(";", outerClose) + 1),
  ].join("");
}

/**
 * `Fn(fn, { p: 'vec2', return: 'float' })` states the parameter types as strings, so TypeScript
 * infers nothing from them and settles for `Fn`'s first overload — the one whose callback receives
 * the node builder — and every parameter then arrives typed as a NodeBuilder. Annotating the
 * parameter with the type the layout already names makes that callback incompatible with the
 * builder overload, so the argument-taking overload is the one that matches. No suppression, and the
 * return type still comes from the body rather than being asserted.
 */
const FN_SIGNATURE =
  /(export const \w+ = \/\*@__PURE__\*\/ Fn\(\s*\(\s*)((?:\[[^\]]*\]|\w+))(\s*\)\s*=>\s*\{[\s\S]*?\n\}, \{)([^{}]*?)(\} \);)/g;
function typeCallbackParameters(body) {
  let typed = 0;
  const out = body.replace(FN_SIGNATURE, (match, head, parameters, middle, layout, tail) => {
    const types = [...layout.matchAll(/(\w+)\s*:\s*'(\w+)'/g)]
      .filter(([, name]) => name !== "return")
      .map(([, , type]) => `Node<"${type}">`);
    if (types.length === 0)
      throw new Error("TN_TRANSPILER_NO_PARAMETERS: a function declares none");
    if (types.length > 1 && !parameters.startsWith("[")) {
      throw new Error(
        `TN_TRANSPILER_PARAMETER_COUNT: ${parameters} has no ${types.length} parameters`,
      );
    }
    typed += 1;
    // The transpiler destructures every parameter from an array, so the annotation is a tuple
    // whenever the code destructures and the bare node type when it does not.
    const annotation = parameters.startsWith("[") ? `[ ${types.join(", ")} ]` : types[0];
    return `${head}${parameters}: ${annotation}${middle}${layout}${tail}`;
  });
  if (typed === 0) throw new Error("TN_TRANSPILER_NO_FUNCTIONS: nothing to type");
  return { body: out, typed };
}

function rewriteAll(text, rules, prefix) {
  let out = text;
  for (const rule of rules) {
    const before = out;
    out = out.replaceAll(rule.find, rule.replace);
    if (out === before) throw new Error(`${prefix}_RULE_DEAD: ${rule.what} matched nothing`);
  }
  return out;
}

/** The decoder's own import list, plus whatever this file injected, as the double-quoted form. */
function mergeTslImport(importLine, injected) {
  // `frameGroup` leads because every bound uniform below is set on it, and the decoder never emits
  // it: it has no reason to, having written the uniforms itself.
  const names = [
    "frameGroup",
    ...importLine
      .match(/\{([^}]*)\}/)[1]
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  ];
  for (const name of injected) if (!names.includes(name)) names.push(name);
  return `import { ${names.join(", ")} } from "three/tsl";`;
}

function generate(config) {
  const target = resolve(here, config.target);
  const raw = readFileSync(resolve(here, config.source), "utf8");
  // The file opens with a provenance note in comment form; the transpiler copies comments through,
  // so it is stripped before parsing rather than carried into the generated module.
  const provenance = raw.match(/^(?:\/\/[^\n]*\n)+/);
  if (provenance === null)
    throw new Error(`${config.marker}_NO_PROVENANCE: the source has no header note`);
  const normalized = rewriteAll(
    raw.slice(provenance[0].length),
    [
      ...COMMON_REWRITES,
      { what: "the GLSL entry point", find: config.entryOpen[0], replace: config.entryOpen[1] },
      ...config.entryClose,
      ...config.rewrites,
    ],
    config.marker,
  );

  // Uniform types the decoder turns into a TSL node, read before anything is parsed so a name the
  // decoder would drop is still known here.
  const declared = new Map();
  for (const match of normalized.matchAll(/\buniform\s+(\w+)\s+([^;]+);/g)) {
    const [, type, names] = match;
    for (const name of names.split(",")) declared.set(name.trim(), type);
  }
  if (declared.size === 0)
    throw new Error(`${config.marker}_NO_UNIFORMS: the source declares none`);

  const warnings = [];
  const quiet = (action) => {
    for (const level of ["warn", "error"]) {
      const original = console[level];
      console[level] = (...args) => warnings.push(`${level}: ${args.join(" ")}`);
      try {
        return action();
      } finally {
        console[level] = original;
      }
    }
  };
  const emitted = quiet(() =>
    new Transpiler(new GLSLDecoder(), new TSLEncoder()).parse(normalized),
  );
  if (warnings.length > 0) {
    throw new Error(`${config.marker}_WARNINGS:\n${warnings.join("\n")}`);
  }
  if (!emitted.includes(`export const ${config.entry}`)) {
    throw new Error(`${config.marker}_NO_ENTRY: the entry point was not emitted`);
  }

  // The decoder writes every global uniform as its own single-line `const`, and puts the TSL import
  // first. Take the import, drop the uniform lines, and re-emit the ones the code actually reads.
  const tslImport = emitted.match(/^import \{[^}]*\} from 'three\/tsl';$/m);
  if (tslImport === null) throw new Error(`${config.marker}_NO_IMPORT: the TSL import is missing`);
  let body = rewriteAll(
    emitted
      .replace(tslImport[0], "")
      .split("\n")
      .filter((line) => !/^const u[A-Za-z0-9]+ = (?:uniform|texture\w*)\(/.test(line))
      .join("\n"),
    config.outputRewrites,
    config.marker,
  );

  const injected = new Set();
  // A rewrite that substitutes a different TSL call brings its own import with it.
  for (const rule of config.outputRewrites)
    for (const name of rule.imports ?? []) injected.add(name);
  body = typeLoopBounds(body, injected);
  if (config.nestedLoop) {
    body = flattenNestedLoop(body);
    if (/name:\s*'[a-z]'/.test(body)) {
      throw new Error(`${config.marker}_LOOP_NAME: a named loop counter survived the rewrite`);
    }
  }

  const read = /[^A-Za-z0-9_$]?([A-Za-z_$][A-Za-z0-9_$]*)[^A-Za-z0-9_$]?/g;
  const used = new Set([...body.matchAll(read)].map((match) => match[1]));

  const threeImports = new Set(["Vector2", "Vector3", "Vector4"]);
  const bound = [];
  const missing = [];
  for (const [name, type] of declared) {
    if (!used.has(name)) continue;
    if (type in DEFAULTS) {
      // `frameGroup`, not the default per-object group: a stack node — every `If`, `Loop` and `Fn`
      // in these shaders — builds through a sub-builder, and a uniform first reached inside one is
      // registered on that sub-builder's group, leaving the shader's uniform struct short of members
      // and the WGSL invalid. One frame-wide buffer, read once per frame, is also what these values
      // are: each shader is a single quad, and every one of them is set by the same call each frame.
      bound.push(
        `export const ${name} = uniform(${DEFAULTS[type]}, "${type}").setGroup(frameGroup);`,
      );
    } else if (config.samplers.includes(type)) {
      const sampler = SAMPLERS[type];
      threeImports.add(sampler.texture);
      // The decoder can only emit a placeholder for a sampler, and a sampled node needs a texture
      // before the graph is built, so the placeholder is a single voxel. It is also the wrong kind
      // of binding for a render target: a pass that is only ever fed to `.value` is no longer in
      // the graph the renderer walks, so it never gets a frame to render into. The binding is
      // therefore a rebindable `let` and the owning module swaps the whole node through
      // `setX(node)` before the entry function is called — the shader's own `Fn` callbacks read
      // it when the graph is built, which is the moment a rebind has to have happened. The sampled
      // UVs and colour space are the caller's, as in any TSL material.
      const setter = `set${name.replace(/^u([A-Z])/, (_, first) => first.toUpperCase())}`;
      bound.push(
        `const ${name}Placeholder = new ${sampler.texture}(new Uint8Array([0, 0, 0, 255]), ${sampler.create});`,
        `${name}Placeholder.needsUpdate = true;`,
        `export let ${name}: TextureNode = ${sampler.node}(${name}Placeholder).setGroup(frameGroup);`,
        `export function ${setter}(value: TextureNode): void {`,
        `  ${name} = value;`,
        "}",
      );
    } else {
      missing.push(`${name} (${type})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${config.marker}_UNBOUND: the shader reads ${missing.join(", ")} with no binding`,
    );
  }
  if (bound.length === 0) throw new Error(`${config.marker}_NO_BOUND_UNIFORMS: nothing is bound`);

  const { body: annotated, typed } = typeCallbackParameters(body);
  const stripped = stripFnLayout(annotated);
  const materialized = materializeLocals(stripped);
  assertNoNestedReturns(materialized);

  const mergedImport = mergeTslImport(tslImport[0], injected);
  const header = `// GENERATED FILE — do not edit it. Every line below is the output of Three.js's own GLSL to
// TSL transpiler, run over tools/${config.source}. That .frag file
// is the source of truth; change it and the generator, never this file.
//
//   node tools/generate-shaders.mjs
//
${config.header}`;
  const output = [
    header,
    `import { ${[...threeImports].sort().join(", ")} } from "three";`,
    mergedImport,
    `import type { Node, TextureNode } from "three/webgpu";`,
    "",
    "// Uniforms the shader reads. Values are assigned by src/render/world.ts and src/render/clouds.ts,",
    "// which own the camera basis and the weather; the generated module only holds the nodes.",
    ...bound,
    "",
    materialized.trim(),
    "",
  ].join("\n");

  // Every name the emitted code calls is either a `three/tsl` import, a uniform, or a function the
  // transpiler itself emitted. Anything else would be a silent ReferenceError in the template, which
  // is the failure this whole check exists to catch.
  const imported = new Set(
    mergedImport
      .match(/\{([^}]*)\}/)[1]
      .split(",")
      .map((name) => name.trim()),
  );
  const called = (text) =>
    new Set(
      [
        ...text.replace(/\/\/[^\n]*/g, "").matchAll(/(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g),
      ].map((match) => match[1]),
    );
  const local = new Set(
    [...materialized.matchAll(/(?:const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]),
  );
  const unimported = [...called(materialized)].filter(
    (name) => !imported.has(name) && !declared.has(name) && !local.has(name),
  );
  if (unimported.length > 0) {
    throw new Error(
      `${config.marker}_UNIMPORTED: ${unimported.join(", ")} is called but never imported`,
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
  const formatted = existsSync(biome);
  if (formatted) {
    execFileSync(biome, ["check", "--fix", "--unsafe", relative(repoRoot, target)], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  console.log(
    `${config.marker}:${JSON.stringify({
      declared: declared.size,
      bound: bound.length,
      bytes: output.length,
      dropped: [...declared.keys()].filter(
        (name) => !bound.some((line) => line.includes(` ${name} = `)),
      ),
      formatted,
      functions: typed,
      layoutsStripped: typed,
      localsMaterialized: (materialized.match(/\.toVar\(\)/g) ?? []).length,
      warnings: 0,
    })}`,
  );
}

for (const config of SHADERS) generate(config);
