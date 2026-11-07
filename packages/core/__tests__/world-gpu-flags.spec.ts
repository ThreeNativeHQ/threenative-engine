/**
 * PRD-798 phase 1: the launch-flag readers in `world-gpu-scene.ts` had no spec of their own. Each one
 * is a pure read of the three places a launch states its switch — the environment variable a native
 * launch sets, the query string a browser asks with, and the global a test sets — so this pins the
 * default, each source alone, and the order they are read in.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_FLAG,
  GPU_SCENE_FLAG,
  GPU_SCENE_VALIDATE_FLAG,
  SHADOW_GPU_KEYS_FLAG,
  bundlesAsked,
  bundlesRequested,
  gpuSceneRequested,
  gpuSceneValidationRequested,
  lodFromFollowRequested,
  shadowGpuKeysRequested,
} from "../src/world-gpu-scene.js";

const host = globalThis as Record<string, unknown>;
const FLAGS = [GPU_SCENE_FLAG, BUNDLE_FLAG, GPU_SCENE_VALIDATE_FLAG, SHADOW_GPU_KEYS_FLAG];
const GLOBALS = ["__tnGpuScene", "__tnBundles", "__tnGpuSceneValidate", "__tnShadowGpuKeys"];

const ENV = process.env;
function env(name: string, value: string | undefined): void {
  if (value === undefined) delete ENV[name];
  else ENV[name] = value;
}
function query(search: string | undefined): void {
  if (search === undefined) Reflect.deleteProperty(host, "location");
  else host.location = { search };
}
function setGlobal(name: string, value: unknown): void {
  if (value === undefined) delete host[name];
  else host[name] = value;
}

afterEach(() => {
  for (const flag of FLAGS) env(flag, undefined);
  for (const name of GLOBALS) setGlobal(name, undefined);
  query(undefined);
});

describe("gpuSceneRequested", () => {
  it("is on when the launch said nothing", () => {
    expect(gpuSceneRequested()).toBe(true);
  });

  it("turns off from the environment, the query string and the global, and only for 0 or false", () => {
    for (const value of ["0", "false"]) {
      env(GPU_SCENE_FLAG, value);
      expect(gpuSceneRequested(), `TN_GPU_SCENE=${value}`).toBe(false);
    }
    // An unset or empty variable is the same as no variable; `1` says the default.
    for (const value of ["", "1", "true", "yes"]) {
      env(GPU_SCENE_FLAG, value);
      expect(gpuSceneRequested(), `TN_GPU_SCENE=${value}`).toBe(true);
    }
    env(GPU_SCENE_FLAG, undefined);
    for (const search of ["?tnGpuScene=0", "?tnGpuScene=false", "?a=1&tnGpuScene=0&b=2"]) {
      query(search);
      expect(gpuSceneRequested(), search).toBe(false);
    }
    for (const search of ["?tnGpuScene=1", "?tnGpuScene=off", "?tnGpuScene=00"]) {
      query(search);
      expect(gpuSceneRequested(), search).toBe(true);
    }
    query(undefined);
    for (const value of [false, 0, "0", "false"]) {
      setGlobal("__tnGpuScene", value);
      expect(gpuSceneRequested(), `__tnGpuScene=${String(value)}`).toBe(false);
    }
    for (const value of [true, "1"]) {
      setGlobal("__tnGpuScene", value);
      expect(gpuSceneRequested(), `__tnGpuScene=${String(value)}`).toBe(true);
    }
  });

  it("reads the environment before the query string", () => {
    env(GPU_SCENE_FLAG, "0");
    query("?tnGpuScene=1");
    setGlobal("__tnGpuScene", true);
    expect(gpuSceneRequested()).toBe(false);
  });

  it("reads the query string before the global", () => {
    query("?tnGpuScene=0");
    setGlobal("__tnGpuScene", true);
    expect(gpuSceneRequested()).toBe(false);
  });
});

describe("bundlesAsked", () => {
  it("answers default when the launch said nothing", () => {
    expect(bundlesAsked()).toBe("default");
    expect(bundlesRequested()).toBe(true);
  });

  it("answers on and off from all three sources", () => {
    env(BUNDLE_FLAG, "1");
    expect(bundlesAsked()).toBe("on");
    env(BUNDLE_FLAG, "0");
    expect(bundlesAsked()).toBe("off");
    env(BUNDLE_FLAG, "yes");
    expect(bundlesAsked()).toBe("default");

    env(BUNDLE_FLAG, undefined);
    query("?tnBundles=1");
    expect(bundlesAsked()).toBe("on");
    query("?tnBundles=0");
    expect(bundlesAsked()).toBe("off");
    // `true` is an answer the reader accepts, so it is an explicit on rather than a fall-through.
    query("?tnBundles=true");
    expect(bundlesAsked()).toBe("on");

    query(undefined);
    setGlobal("__tnBundles", true);
    expect(bundlesAsked()).toBe("on");
    setGlobal("__tnBundles", false);
    expect(bundlesAsked()).toBe("off");
  });

  it("lets an explicit yes on one seam beat a no on another", () => {
    env(BUNDLE_FLAG, "0");
    query("?tnBundles=1");
    expect(bundlesAsked()).toBe("on");
    query(undefined);
    expect(bundlesAsked()).toBe("off");
    // And the other way round: a global's no does not silence the environment's yes.
    env(BUNDLE_FLAG, "1");
    setGlobal("__tnBundles", false);
    expect(bundlesAsked()).toBe("on");
  });

  // `bundles` answers three ways where the other switches answer two: a launch that said nothing
  // gets the measurement's default, which is neither of the answers a caller can type.
  it("keeps a value it does not understand as default rather than as on", () => {
    query("?tnBundles=yes");
    expect(bundlesAsked()).toBe("default");
    query("?tnBundles");
    expect(bundlesAsked()).toBe("on");
  });

  it("reports the option bundlesRequested reads", () => {
    env(BUNDLE_FLAG, "0");
    expect(bundlesRequested()).toBe(false);
    env(BUNDLE_FLAG, "1");
    expect(bundlesRequested()).toBe(true);
    env(BUNDLE_FLAG, undefined);
    expect(bundlesRequested()).toBe(true);
  });
});

describe("shadowGpuKeysRequested", () => {
  it("is off unless asked, from any source", () => {
    expect(shadowGpuKeysRequested()).toBe(false);
    for (const value of ["1", "true"]) {
      env(SHADOW_GPU_KEYS_FLAG, value);
      expect(shadowGpuKeysRequested(), `TN_SHADOW_GPU_KEYS=${value}`).toBe(true);
    }
    for (const value of ["0", "false", ""]) {
      env(SHADOW_GPU_KEYS_FLAG, value);
      expect(shadowGpuKeysRequested(), `TN_SHADOW_GPU_KEYS=${value}`).toBe(false);
    }
    // One rule for every switch: only `0` and `false` are off, so any other value asks for it.
    env(SHADOW_GPU_KEYS_FLAG, "yes");
    expect(shadowGpuKeysRequested()).toBe(true);
    env(SHADOW_GPU_KEYS_FLAG, undefined);
    query("?tnShadowGpuKeys=1");
    expect(shadowGpuKeysRequested()).toBe(true);
    query("?tnShadowGpuKeys=0");
    expect(shadowGpuKeysRequested()).toBe(false);
    query(undefined);
    setGlobal("__tnShadowGpuKeys", true);
    expect(shadowGpuKeysRequested()).toBe(true);
    setGlobal("__tnShadowGpuKeys", "1");
    expect(shadowGpuKeysRequested()).toBe(true);
  });
});

describe("lodFromFollowRequested", () => {
  it("is the same switch read the other way: on only for an explicit off", () => {
    expect(lodFromFollowRequested()).toBe(false);
    env("TN_LOD_FROM_CAMERA", "0");
    expect(lodFromFollowRequested()).toBe(true);
    env("TN_LOD_FROM_CAMERA", "1");
    expect(lodFromFollowRequested()).toBe(false);
    env("TN_LOD_FROM_CAMERA", undefined);
    query("?tnLodFromCamera=false");
    expect(lodFromFollowRequested()).toBe(true);
  });
});

describe("gpuSceneValidationRequested", () => {
  it("is off by default and treats an empty variable as unset", () => {
    expect(gpuSceneValidationRequested()).toBe(false);
    for (const value of ["", "0", "false"]) {
      env(GPU_SCENE_VALIDATE_FLAG, value);
      expect(gpuSceneValidationRequested(), `TN_GPU_SCENE_VALIDATE=${value}`).toBe(false);
    }
  });

  it("turns on for any other environment value", () => {
    for (const value of ["1", "true", "yes", "0 "]) {
      env(GPU_SCENE_VALIDATE_FLAG, value);
      expect(gpuSceneValidationRequested(), `TN_GPU_SCENE_VALIDATE=${value}`).toBe(true);
    }
  });

  it("turns on for a query parameter that is present and is not 0 or false", () => {
    for (const search of [
      "?tnGpuSceneValidate=1",
      "?tnGpuSceneValidate=true",
      "?a=1&tnGpuSceneValidate=x",
    ]) {
      query(search);
      expect(gpuSceneValidationRequested(), search).toBe(true);
    }
    for (const search of ["?tnGpuSceneValidate=0", "?tnGpuSceneValidate=false"]) {
      query(search);
      expect(gpuSceneValidationRequested(), search).toBe(false);
    }
    // A URL that names the switch and gives it no value has no other way to say yes.
    query("?tnGpuSceneValidate=");
    expect(gpuSceneValidationRequested()).toBe(true);
    query("?other=1");
    expect(gpuSceneValidationRequested()).toBe(false);
  });

  it("turns on for the global a test sets", () => {
    setGlobal("__tnGpuSceneValidate", true);
    expect(gpuSceneValidationRequested()).toBe(true);
    setGlobal("__tnGpuSceneValidate", "1");
    expect(gpuSceneValidationRequested()).toBe(true);
    for (const value of ["0", 0, false, "false"]) {
      setGlobal("__tnGpuSceneValidate", value);
      expect(gpuSceneValidationRequested(), `__tnGpuSceneValidate=${String(value)}`).toBe(false);
    }
    // `true` is one of the two spellings of on, as it is for every other launch switch.
    setGlobal("__tnGpuSceneValidate", "true");
    expect(gpuSceneValidationRequested()).toBe(true);
  });
});
