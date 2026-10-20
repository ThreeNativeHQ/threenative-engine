import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import { checkSourceList, readCmakeSource } from "../scripts/check-source-list.mjs";

const root = join(import.meta.dirname, "..");
const cmake = readCmakeSource(root);
const sourceListScript = readFileSync(join(root, "scripts/check-source-list.mjs"), "utf8");

test("every native C++ source is listed or explicitly excluded", () => {
  const report = checkSourceList({
    cmakeSource: cmake,
    sourceRoot: join(root, "src"),
  });
  assert.deepEqual(report.unlisted, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.excluded, ["src/gltf/gltf_loader.cpp", "src/utils/cgltf_impl.cpp"]);
  assert.match(cmake, /check-source-list\.mjs/u);
  assert.match(sourceListScript, /src\/gltf\/gltf_loader\.cpp/u);
  assert.match(sourceListScript, /src\/utils\/cgltf_impl\.cpp/u);
});

test("the source-list guard fails closed for a newly added unlisted source", () => {
  const report = checkSourceList({
    cmakeSource: cmake,
    sourcePaths: ["src/runtime.cpp", "src/new-unlisted.cpp"],
  });
  assert.deepEqual(report.unlisted, ["src/new-unlisted.cpp"]);
});

test("the source-list guard rejects a source commented out of CMake", () => {
  const commentedCmake = cmake.replace(
    /^([ \t]*)src\/runtime\.cpp$/mu,
    "$1# src/runtime.cpp",
  );
  assert.notEqual(commentedCmake, cmake, "negative control must comment out a CMake source entry");
  const report = checkSourceList({
    cmakeSource: commentedCmake,
    sourcePaths: ["src/runtime.cpp"],
  });
  assert.deepEqual(report.unlisted, ["src/runtime.cpp"]);
});
