// Lightweight source-measurement oracle. Run with tsx; this is not visual/native acceptance.
import assert from "node:assert/strict";
import {
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  Texture,
  UnsignedByteType,
} from "three";
import { measureEnvironment, reportEnvironmentContribution } from "./environment.ts";
let checks = 0;
const check = (name, run) => {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
};
const scene = new Scene();
const bind = (data, width, height, type) => {
  const texture = new DataTexture(data, width, height, RGBAFormat, type);
  texture.mapping = EquirectangularReflectionMapping;
  scene.environment = texture;
  scene.environmentIntensity = 1;
  return texture;
};
check("missing is measured zero, distinct from unreadable", () => {
  assert.equal(measureEnvironment(scene, 16).meanRadiance, 0);
  const image = new Texture({ width: 2, height: 2 });
  image.mapping = EquirectangularReflectionMapping;
  scene.environment = image;
  assert.equal(measureEnvironment(scene, 16).status, "unknown");
});
check("spherical row measure does not overweight the poles", () => {
  bind(new Float32Array([1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1]), 1, 4, FloatType);
  assert.ok(Math.abs(measureEnvironment(scene, 16).meanRadiance - (1 - Math.SQRT1_2)) < 1e-12);
});
check("active environment intensity scales source radiance", () => {
  scene.environmentIntensity = 2.5;
  assert.ok(
    Math.abs(measureEnvironment(scene, 16).meanRadiance - 2.5 * (1 - Math.SQRT1_2)) < 1e-12,
  );
});
check("sRGB decoding happens before radiance averaging", () => {
  const t = bind(new Uint8Array([128, 128, 128, 255]), 1, 1, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  assert.ok(Math.abs(measureEnvironment(scene, 16).meanRadiance - 0.21586050011389926) < 1e-12);
});
check("measurement refuses over-budget source", () => {
  bind(new Uint8Array(8), 2, 1, UnsignedByteType);
  assert.equal(measureEnvironment(scene, 1).status, "unknown");
});
check("invalid sample counts and negative radiance stay unknown", () => {
  bind(new Float32Array([1, 1, 1]), 1, 1, FloatType);
  assert.equal(measureEnvironment(scene, 16).status, "unknown");
  bind(new Float32Array([-1, 0, 0, 1]), 1, 1, FloatType);
  assert.equal(measureEnvironment(scene, 16).status, "unknown");
});
check("invalid intensity is never presented as black IBL", () => {
  bind(new Float32Array([1, 1, 1, 1]), 1, 1, FloatType);
  scene.environmentIntensity = Number.NaN;
  assert.equal(measureEnvironment(scene, 16).status, "unknown");
});
check("zero overrides preserve measured report and do not admit a fill", () => {
  bind(new Float32Array([0, 0, 0, 1]), 1, 1, FloatType);
  const original = console.info;
  const calls = [];
  console.info = (...values) => calls.push(values);
  try {
    const report = reportEnvironmentContribution(scene, {
      darkThreshold: 0.01,
      rimGain: 0,
      fillGain: 0,
      fillAdmitted: false,
      fillColor: new Color(0),
      maxSourceTexels: 16,
    });
    assert.equal(report.meanRadiance, 0);
    assert.equal(report.environmentState, "dark");
    assert.equal(report.ibl, "non-contributing");
    assert.equal(report.analyticFill.admitted, false);
    assert.equal(report.analyticFill.effectiveGain, 0);
    assert.ok(calls[0][0].startsWith("TN_ENVIRONMENT_CONTRIBUTION:"));
    assert.equal(
      JSON.parse(calls[0][0].slice("TN_ENVIRONMENT_CONTRIBUTION:".length)).ibl,
      "non-contributing",
    );
  } finally {
    console.info = original;
  }
});
check("invalid work budget refuses before measurement", () => {
  assert.throws(() => measureEnvironment(scene, 0), /budget/);
});
console.log(`${checks} CPU measurement checks passed; no default/native/visual admission.`);
