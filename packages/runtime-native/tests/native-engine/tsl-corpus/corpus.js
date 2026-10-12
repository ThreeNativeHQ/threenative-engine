// The 32 upstream graphs from reference.ts, authored against the native V8 tsl global.
const {
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  cos,
  cross,
  depth,
  distance,
  dot,
  exp2,
  float,
  floor,
  fract,
  frameGroup,
  fwidth,
  getViewPosition,
  hash,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  mat2,
  min,
  mix,
  mod,
  normalLocal,
  normalWorld,
  normalWorldGeometry,
  normalize,
  positionViewDirection,
  positionGeometry,
  positionLocal,
  positionPrevious,
  pow,
  property,
  saturation,
  screenCoordinate,
  screenSize,
  select,
  sin,
  smoothstep,
  storage,
  sqrt,
  step,
  tangentLocal,
  texture,
  time: frameTime,
  uint,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} = tsl;
const albedo = { name: "albedo" };
albedo.name = "albedo";
const u = uniform(0.5).setName("u");
const tint = uniform(vec3(1, 0.5, 0.25)).setName("tint");
const time = uniform(0).setName("time");
// storage() over an engine BufferAttribute: the runner installs the classes (V8) or passes them (Wasm).
const palette = storage(new BufferAttribute(new Float32Array(64), 4), "vec4", 16).setName("palette").toReadOnly();

/** name -> the output it writes and the expression; the C++ twin builds the same, in order. */
const CORPUS = [
  ["scale-by-uniform", "position", vec4(positionLocal.mul(u), 1)],
  ["swizzle-and-join", "color", vec4(positionLocal.zyx, positionLocal.x)],
  ["sin-of-sum", "color", vec4(vec3(sin(float(2).add(u))), 1)],
  ["attribute-weight", "position", vec4(positionLocal.mul(attribute("weight", "float")), 1)],
  ["vector-math", "color", vec4(normalize(cross(positionLocal, tint)), dot(positionLocal, tint))],
  ["length-distance", "color", vec4(length(positionLocal), distance(positionLocal, tint), 0, 1)],
  [
    "mix-clamp-smoothstep",
    "color",
    vec4(mix(tint, positionLocal, clamp(u, 0, 1)), smoothstep(0, 1, u)),
  ],
  ["unary-math", "color", vec4(abs(u), floor(u), fract(u), sqrt(u))],
  ["binary-math", "color", vec4(pow(u, 2), min(u, time), max(u, time), step(u, time))],
  ["exp-cos", "color", vec4(exp2(u), cos(time), 0, 1)],
  ["compare-select", "color", vec4(vec3(select(u.lessThan(time), u, time)), 1)],
  ["greater-select", "color", vec4(vec3(select(u.greaterThan(0.25), float(1), float(0))), 1)],
  ["negate-sub-div", "color", vec4(u.negate(), u.sub(time), u.div(2), 1)],
  ["uv-texture", "color", texture(albedo, uv())],
  ["texture-scaled-uv", "color", texture(albedo, uv().mul(2)).mul(u)],
  ["int-convert", "color", vec4(float(int(3)), float(uint(4)), 0, 1)],
  ["vector-constants", "color", vec4(vec3(1, 2, 3).add(tint), 1)],
  ["constant-splat", "color", vec4(vec3(0.5).mul(tint), 1)],
  ["vec2-swizzle", "color", vec4(vec2(u, time).yx, 0, 1)],
  ["instance-offset", "position", vec4(positionLocal.add(vec3(float(instanceIndex), 0, 0)), 1)],
  ["time-wave", "position", vec4(positionLocal.add(vec3(0, sin(time.add(positionLocal.x)), 0)), 1)],
  ["camera-position", "color", vec4(cameraPosition, 1)],
  ["camera-projection", "position", cameraProjectionMatrix.mul(vec4(positionGeometry, 1))],
  ["camera-world-matrix", "color", cameraWorldMatrix.mul(vec4(1, 0, 0, 0))],
  ["position-geometry", "position", vec4(positionGeometry.xy, 0, 1)],
  ["normal-world", "color", vec4(normalWorld, 1)],
  ["varying-fragment", "color", vec4(varying(positionGeometry.mul(u), "scaled"), 1)],
  ["varying-vertex", "position", vec4(varying(positionGeometry.mul(u), "scaled"), 1)],
  ["atan", "color", vec4(atan(u), atan(time, u), 0, 1)],
  ["mod", "color", vec4(mod(positionLocal, tint), mod(u, time))],
  ["fwidth", "color", vec4(fwidth(uv()), fwidth(u), 1)],
  ["saturation", "color", vec4(saturation(tint, u), 1)],
  ["mat2", "color", vec4(mat2(vec2(1, 0), vec2(0, 1)).mul(vec2(u, time)), 0, 1)],
  ["hash", "color", vec4(hash(u), 0, 0, 1)],
  ["time", "color", vec4(frameTime, 0, 0, 1)],
  ["normal-local", "position", vec4(positionLocal.add(normalLocal.mul(u)), 1)],
  ["tangent-local", "position", vec4(positionLocal.add(tangentLocal.mul(u)), 1)],
  ["position-previous", "color", vec4(positionPrevious, 1)],
  ["storage-attribute", "position", vec4(positionLocal.add(palette.element(instanceIndex).xyz), 1)],
  ["screen-coordinate", "color", vec4(screenCoordinate, 0, 1)],
  ["position-view-direction", "color", vec4(positionViewDirection, 1)],
  ["screen-size", "color", vec4(screenSize, 0, 1)],
  ["depth", "color", vec4(depth, 0, 0, 1)],
  ["normal-world-geometry", "color", vec4(normalWorldGeometry, 1)],
  ["get-view-position", "color", vec4(getViewPosition(uv(), u, cameraProjectionMatrix), 1)],
  ["set-group", "color", vec4(uniform(0.25).setName("grouped").setGroup(frameGroup), 0, 0, 1)],
  ["transform-normal-to-view", "color", vec4(transformNormalToView(tint), 1)],
  ["property", "color", vec4(property("vec3").add(tint), 1)],
];

const positions = instancedArray(16, "vec4").setName("positions");

/** Compute graphs: an `Fn` body, authored the same way in tsl_corpus.cpp. */
const STATEMENTS = [
  [
    "fn-if-store",
    () => {
      const acc = float(0).toVar();
      If(instanceIndex.lessThan(uint(16)), () => {
        acc.assign(acc.add(1));
        positions.element(instanceIndex).assign(vec4(acc, 0, 0, 1));
      });
    },
  ],
  [
    "loop-accumulate",
    () => {
      const acc = float(0).toVar();
      Loop(4, ({ i }) => {
        acc.assign(acc.add(float(i)));
      });
      positions.element(instanceIndex).assign(vec4(acc, 0, 0, 1));
    },
  ],
  [
    "if-else",
    () => {
      If(instanceIndex.lessThan(uint(8)), () => {
        positions.element(instanceIndex).assign(vec4(1, 0, 0, 1));
      }).Else(() => {
        positions.element(instanceIndex).assign(vec4(0, 1, 0, 1));
      });
    },
  ],
  [
    "storage-read-modify",
    () => {
      positions.element(instanceIndex).assign(positions.element(instanceIndex).mul(2));
    },
  ],
];

[...CORPUS, ...STATEMENTS.map(([name, body]) => [name, "compute", Fn(body)()])];
