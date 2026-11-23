import * as THREE from "three/webgpu";
import { attribute, cameraViewMatrix, length, normalize, uniform, varying, vec4 } from "three/tsl";
import { HairStrands3D } from "@threenative/core";
import { createHairCardMaterial } from "../../../../create-threenative/templates/starter/src/render/effects/hair.ts";
import { startVisualScene } from "./scene-support.js";

// 24 guide strands on a moving head bone, simulated by the shipped `HairStrands3D` solver on both
// hosts and drawn with the starter template's hair-card material, which reads the solver buffer in
// its position node. The head moves for a fixed number of steps during setup; the frame loop only
// draws, so every host captures the same hair.
const STEPS = 60;
const GUIDES = 24;
const POINTS = 16;

/** A strand data atlas in the layout `createHairCardMaterial` reads: R coverage, G root (0) to tip
 * (1), B a per-strand seed. Copied from `examples/character-dynamics/src/hair-atlas.ts` as plain JS,
 * because a conformance scene bundles without the example's TypeScript. */
function strandAtlas(strands = 40, width = 128, height = 256) {
  const data = new Uint8Array(width * height * 4);
  const hash = (n) => Math.abs((Math.sin(n * 12.9898) * 43758.5453) % 1);
  for (let y = 0; y < height; y++) {
    const along = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let coverage = 0;
      let seed = 0;
      for (let lane = 0; lane < strands; lane++) {
        const own = hash(lane + 1);
        const tip = 0.7 + 0.3 * hash(lane + 101);
        if (along > tip) continue;
        const centre = ((lane + 0.5 + 0.6 * Math.sin(along * 4 + own * 6.28)) / strands) * width;
        const half = 1.8 - 1.2 * (along / tip);
        const edge = Math.min(1, Math.max(0, half + 0.5 - Math.abs(x + 0.5 - centre)));
        const fade = Math.min(1, (tip - along) / 0.12);
        const c = edge * fade;
        if (c > coverage) {
          coverage = c;
          seed = own;
        }
      }
      const i = (y * width + x) * 4;
      data[i] = Math.round(coverage * 255);
      data[i + 1] = Math.round(along * 255);
      data[i + 2] = Math.round(seed * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The strand direction for three's `anisotropyMap`: RG the tangent-space direction in [0, 1], B the
 * strength. A strand runs along V, so the direction is +V everywhere. Copied from
 * `examples/character-dynamics/src/hair-atlas.ts` as plain JS. */
function strandTangents(width = 4, height = 4) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([128, 255, 255, 255], i);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function assertHairCardsProof(hair, passes) {
  if (hair?.positions?.isStorageBufferNode !== true || hair.strandCount !== GUIDES) {
    throw new Error("Hair-cards proof requires a HairStrands3D position buffer.");
  }
  if (!(hair.warmupNodes?.length > 0)) {
    throw new Error("Hair-cards proof requires the solver's compute nodes.");
  }
  if (!passes?.outer || passes.inner !== null || !passes.blend) {
    throw new Error("Hair-cards proof requires the material's a2c outer pass and its blended fringe.");
  }
}

export async function startScene(canvas, dimensions) {
  // `antialias` gives the 4x MSAA alpha-to-coverage resolves, as the starter's high tier runs.
  return startVisualScene(
    canvas,
    dimensions,
    "hair-cards",
    async ({ camera, renderer, scene }) => {
      const root = new THREE.Group();
      const head = new THREE.Object3D();
      head.position.set(0, 1.7, 0);
      root.add(head);
      scene.add(root);
      root.updateMatrixWorld(true);
      const skull = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 32, 16),
        new THREE.MeshStandardNodeMaterial({ color: 0xb08a6a, roughness: 0.7 }),
      );
      head.add(skull);

      // Guides start on the back of the skull and fall back and down.
      const guides = new Float32Array(GUIDES * POINTS * 3);
      for (let g = 0; g < GUIDES; g++) {
        const x = ((g + 0.5) / GUIDES - 0.5) * 0.12;
        for (let p = 0; p < POINTS; p++)
          guides.set([x, 1.75 - p * 0.025, -0.11 - p * 0.008], (g * POINTS + p) * 3);
      }
      const hair = new HairStrands3D(guides, {
        pointsPerStrand: POINTS,
        bone: head,
        colliders: [{ bone: head, end: new THREE.Vector3(0, 0.001, 0), radius: 0.1 }],
      });
      scene.add(hair);

      // The head's world frame for the cards' across vectors, refreshed every step.
      const headFrame = uniform(head.matrixWorld.clone());
      const cardPoint = new Float32Array(GUIDES * POINTS * 2);
      const cardAcross = new Float32Array(GUIDES * POINTS * 2 * 3);
      const cardUv = new Float32Array(GUIDES * POINTS * 2 * 2);
      const triangles = [];
      for (let g = 0; g < GUIDES; g++)
        for (let p = 0; p < POINTS; p++) {
          const v = (g * POINTS + p) * 2;
          const half = 0.012 * (1 - (0.5 * p) / (POINTS - 1));
          for (const side of [0, 1]) {
            cardPoint[v + side] = g * POINTS + p;
            cardUv.set([side, p / (POINTS - 1)], (v + side) * 2);
            cardAcross.set([side === 0 ? -half : half, 0, 0], (v + side) * 3);
          }
          if (p + 1 < POINTS) triangles.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      const cardGeometry = new THREE.BufferGeometry();
      cardGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(cardPoint.length * 3), 3),
      );
      cardGeometry.setAttribute("guidePoint", new THREE.BufferAttribute(cardPoint, 1));
      cardGeometry.setAttribute("across", new THREE.BufferAttribute(cardAcross, 3));
      cardGeometry.setAttribute("uv", new THREE.BufferAttribute(cardUv, 2));
      cardGeometry.setIndex(triangles);
      // PRD-909's card material from the starter template's generated `src/render/effects/hair.ts`, with a
      // generated strand atlas; each pass reads the solver buffer in its position node.
      const cardPosition = hair.positions
        .element(attribute("guidePoint", "float").toUint())
        .add(
          normalize(headFrame.mul(vec4(attribute("across", "vec3"), 0)).xyz).mul(
            length(attribute("across", "vec3")),
          ),
        );
      // Hair-card normals point out from the head: the cards carry no normal attribute.
      const cardNormal = normalize(
        cameraViewMatrix.mul(
          vec4(varying(normalize(cardPosition.sub(headFrame.mul(vec4(0, 0, 0, 1)).xyz))), 0),
        ).xyz,
      );
      const passes = createHairCardMaterial({
        atlas: strandAtlas(),
        tangent: strandTangents(),
        // The tangent map already points along the strand (+V); upstream's -1.09 suits its own atlases.
        anisotropyRotation: 0,
        alphaToCoverage: true,
      });
      assertHairCardsProof(hair, passes);
      let cardMesh;
      [passes.inner, passes.outer, passes.blend].forEach((material, order) => {
        if (material === null) return;
        material.positionNode = cardPosition;
        material.normalNode = cardNormal;
        const cards = new THREE.Mesh(cardGeometry, material);
        cards.frustumCulled = false;
        cards.renderOrder = order;
        scene.add(cards);
        if (material === passes.outer) cardMesh = cards;
      });

      const key = new THREE.DirectionalLight(0xfff2e0, 3.2);
      key.position.set(1.2, 2.5, -2.6);
      scene.add(key, key.target, new THREE.AmbientLight(0x8fb8d8, 0.55));

      // A game warms its pipelines before the first frame.
      await renderer.compileAsync(scene, camera);
      // The head walks forward, turns and stops for one second; the hair trails and swings.
      for (let step = 0; step < STEPS; step++) {
        root.position.z = step < 40 ? 0.04 * step : 1.6;
        head.rotation.y = 0.6 * Math.sin(step / 8);
        root.updateMatrixWorld(true);
        headFrame.value.copy(head.matrixWorld);
        hair.process(renderer);
      }
      camera.position.set(-0.35, 1.8, root.position.z - 0.7);
      camera.lookAt(0, 1.6, root.position.z);
      return {
        detail: {
          guides: GUIDES,
          pointsPerStrand: POINTS,
          steps: STEPS,
          substeps: hair.debug().substeps,
          mode: passes.mode,
          passes: [passes.inner, passes.outer, passes.blend].filter((pass) => pass !== null).length,
        },
        mesh: cardMesh,
      };
    },
    { renderer: { antialias: true } },
  );
}
