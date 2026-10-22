import * as THREE from "three/webgpu";
import { cameraPosition, normalWorld, positionWorld, reflect, select, vec3 } from "three/tsl";
import { TracedReflections } from "../../../../core/src/render/traced-reflections.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-642: a mirror sphere shows what the camera cannot see. The red, green and yellow walls sit beside and
 * behind the camera, outside the frustum, so only a ray that walks the scene's packed triangles can paint them
 * on the sphere (a screen-space march has no pixel to hit). The ray runs in the mirror's own material, so the
 * browser and the native host run the same TSL kernel: a host that drops the float textures, the loop over a
 * leaf's triangles or the `textureLoad` leaves the sphere flat and misses the browser reference.
 */
const MISS = 0.08;
const SUN = [0.3, 0.8, 0.5];

function wall(color, width, position, rotationY) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 6),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
  );
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.updateMatrixWorld(true);
  return mesh;
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "traced-reflections",
    ({ camera, scene }) => {
      const walls = [
        wall(0xd02020, 8.5, [-3, 0, 4.75], Math.PI / 2),
        wall(0x20b040, 8.5, [3, 0, 4.75], -Math.PI / 2),
        wall(0xe0c020, 8, [0, 0, 7], Math.PI),
      ];
      scene.add(...walls);
      const mirror = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 24),
        new THREE.MeshBasicNodeMaterial(),
      );
      scene.add(mirror);
      scene.updateMatrixWorld(true);

      const trace = new TracedReflections(scene, { marker: false });
      assertCondition(trace.report.triangles > 1000, "the pack holds the walls and the mirror");
      assertCondition(trace.weightAt(0.05) === 1 && trace.weightAt(0.4) === 0, "weight follows the 0.4 cut-off");

      // The mirror reflects the view ray about its normal, then shows the hit's colour lit by a fixed light.
      const incident = positionWorld.sub(cameraPosition).normalize();
      const normal = normalWorld.normalize();
      const hit = trace.trace({
        origin: positionWorld.add(normal.mul(0.01)),
        direction: reflect(incident, normal).normalize(),
      });
      const light = hit.normal.dot(vec3(...SUN).normalize()).mul(0.5).add(0.5);
      // A miss leaves the hit fields undefined, so a blend would carry them into the pixel: select takes the miss colour.
      mirror.material.colorNode = select(hit.hit.greaterThan(0), hit.albedo.mul(light), vec3(MISS));

      return {
        detail: { triangles: trace.report.triangles, nodes: trace.report.nodes, walls: walls.length },
        mirror,
      };
    },
    {
      background: 0x090b14,
      camera: (size) => {
        const view = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
        view.position.set(0, 0.4, 4);
        view.lookAt(0, 0, 0);
        return view;
      },
    },
  );
}
