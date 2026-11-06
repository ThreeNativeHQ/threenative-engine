import { createRenderer } from "../../../../core/src/renderer.ts";
import { THREE, assertCondition } from "./scene-support.js";

export async function startScene(canvas, dimensions) {
  const { width, height } = dimensions;
  const renderer = await createRenderer({
    canvas,
    antialias: false,
    preferWebGPU: true,
    pixelRatio: 1,
    pipelineCensus: false,
  });

  // Each mip holds one 8-byte BC1 block. Endpoint 0 is red (RGB565 0xf800).
  // Endpoint 1 is green (0x07e0). Index bytes 0, 0, 85, 85 paint rows 0-1 red
  // and rows 2-3 green.
  const block = [0, 248, 224, 7, 0, 0, 85, 85];
  const source = new THREE.CompressedTexture(
    [
      { data: new Uint8Array(block), width: 4, height: 4 },
      { data: new Uint8Array(block), width: 2, height: 2 },
      { data: new Uint8Array(block), width: 1, height: 1 },
    ],
    4,
    4,
    THREE.RGB_S3TC_DXT1_Format,
  );
  source.minFilter = THREE.NearestMipmapNearestFilter;
  source.magFilter = THREE.NearestFilter;
  source.needsUpdate = true;

  // Snapshot the source. Preparation must leave each reference unchanged.
  const sourceUuid = source.uuid;
  const sourceVersion = source.version;
  const mipArray = source.mipmaps;
  const mipRefs = source.mipmaps.map((mip) => ({ mip, data: mip.data }));
  const originalSource = source.source;
  const originalSourceVersion = originalSource.version;

  assertCondition(
    typeof renderer.prepareTextures === "function",
    "prepareTextures is not a public function",
  );
  const replacements = new Map();
  const count = await renderer.prepareTextures(
    [source],
    undefined,
    undefined,
    replacements,
  );
  assertCondition(count === 1, `prepared ${count} textures, expected 1`);

  const replacement = replacements.get(source);
  assertCondition(
    replacement?.isExternalTexture === true,
    "source did not map to an ExternalTexture",
  );
  assertCondition(source.uuid === sourceUuid, "source identity changed");
  assertCondition(source.version === sourceVersion, "source version changed");
  assertCondition(
    source.source === originalSource,
    "texture source identity changed",
  );
  assertCondition(
    originalSource.version === originalSourceVersion,
    "texture source version changed",
  );
  assertCondition(
    source.mipmaps === mipArray && source.mipmaps.length === mipRefs.length,
    "source mip array changed",
  );
  mipRefs.forEach(({ mip, data }, index) => {
    assertCondition(
      source.mipmaps[index] === mip && mip.data === data,
      `mip ${index} changed during preparation`,
    );
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18202f);
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
  camera.position.z = 3.2;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({ map: replacement }),
  );
  scene.add(mesh);

  renderer.setSize(width, height, false);
  renderer.render(scene, camera);
  function frame() {
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // mipLevels counts the submitted mips only.
  // This scene does not check GPU readback.
  globalThis.__TN_CONFORMANCE = {
    ok: true,
    type: "compressed-texture-preparation",
    detail: { prepared: 1, mipLevels: 3, originalStable: true },
  };
  return {
    renderer,
    scene,
    camera,
    subject: { mesh, texture: source, replacement },
  };
}
