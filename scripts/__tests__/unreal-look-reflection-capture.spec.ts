import { Mesh, MeshStandardMaterial, Scene, SphereGeometry, Texture } from "three";
import { describe, expect, it, vi } from "vitest";
import { skyDisc } from "../unreal-look/scaffold/render/gpuSky.js";
import { captureReflections } from "../unreal-look/scaffold/render/reflectionCapture.js";

function fixture() {
  const scene = new Scene();
  const chrome = new Mesh(
    new SphereGeometry(),
    new MeshStandardMaterial({ metalness: 1, roughness: 0.05 }),
  );
  const rough = new Mesh(
    chrome.geometry,
    new MeshStandardMaterial({ metalness: 1, roughness: 0.31 }),
  );
  const dielectric = new Mesh(
    chrome.geometry,
    new MeshStandardMaterial({ metalness: 0, roughness: 0.05 }),
  );
  const emitter = new Mesh(
    chrome.geometry,
    new MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 20 }),
  );
  chrome.position.set(2, 3, 4);
  scene.add(chrome, rough, dielectric, emitter);
  return { scene, chrome, rough, dielectric, emitter };
}

describe("static mirror scene capture", () => {
  it("captures chrome only, after GI, without itself and with the emitter and sky", async () => {
    const { scene, chrome, rough, dielectric, emitter } = fixture();
    scene.background = new Texture();
    const captured = new Texture();
    const renderer = {
      SphereReflectionCapture: vi.fn(async (root, point, size) => {
        expect(root).toBe(scene);
        expect(point.toArray()).toEqual([2, 3, 4]);
        expect(size).toBe(256);
        expect(chrome.visible).toBe(false);
        expect(emitter.visible).toBe(true);
        expect(scene.background).not.toBeNull();
        return captured;
      }),
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const dispose = await captureReflections(renderer, scene, scene);
    expect(renderer.SphereReflectionCapture).toHaveBeenCalledTimes(1);
    expect(chrome.visible).toBe(true);
    expect(chrome.material.envMap).toBe(captured);
    expect(chrome.material.envMapIntensity).toBe(1);
    expect(rough.material.envMap).toBeNull();
    expect(dielectric.material.envMap).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^TN_REFLECTION_CAPTURE \{"objects":1,"faceSize":256,"milliseconds":\d+\}$/,
      ),
    );
    const release = vi.spyOn(captured, "dispose");
    dispose();
    expect(release).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("restores visibility if a capture fails", async () => {
    const { scene, chrome } = fixture();
    const renderer = {
      SphereReflectionCapture: vi.fn(async () => {
        throw new Error("capture failed");
      }),
    };
    await expect(captureReflections(renderer, scene, scene)).rejects.toThrow("capture failed");
    expect(chrome.visible).toBe(true);
  });

  it("hides the sun disc while a face is captured, as Unreal does, and restores it after, even on failure", async () => {
    const { scene } = fixture();
    const seen: number[] = [];
    const renderer = {
      SphereReflectionCapture: vi.fn(async () => {
        seen.push(skyDisc.value);
        if (seen.length === 2) throw new Error("capture failed");
        return new Texture();
      }),
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    skyDisc.value = 1;
    await captureReflections(renderer, scene, scene);
    expect(seen).toEqual([0]);
    expect(skyDisc.value).toBe(1);
    await expect(captureReflections(renderer, scene, scene)).rejects.toThrow("capture failed");
    expect(seen).toEqual([0, 0]);
    expect(skyDisc.value).toBe(1);
    log.mockRestore();
  });
});
