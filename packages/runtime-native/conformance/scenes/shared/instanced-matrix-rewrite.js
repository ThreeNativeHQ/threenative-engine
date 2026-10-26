import { THREE, startVisualScene } from "./scene-support.js";

// setMatrixAt after the first frames, then instanceMatrix.needsUpdate, as a kart's skid trail and item
// boxes do. The basic boxes start as a row at the top and move to a ring from the tenth frame on. The
// lit, transparent boxes start at zero scale (an unlaid trail) and are rewritten every frame from then on.
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "instanced-matrix-rewrite", ({ renderer, scene, camera }) => {
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(1, 2, 3);
    scene.add(sun);
    const basic = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xf6ad55 }),
      6,
    );
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    const cube = new THREE.BoxGeometry(0.22, 0.22, 0.22).toNonIndexed();
    const colours = new Float32Array(cube.getAttribute("position").count * 3);
    for (let v = 0; v < colours.length / 3; v += 1) colours.set(Math.floor(v / 6) % 2 ? [0.3, 0.8, 0.8] : [0.9, 0.4, 0.8], v * 3);
    cube.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    const lit = new THREE.InstancedMesh(
      cube,
      new THREE.MeshStandardMaterial({
        depthWrite: false,
        emissive: 0xffffff,
        emissiveIntensity: 0.12,
        opacity: 0.7,
        transparent: true,
        vertexColors: true,
      }),
      6,
    );
    lit.castShadow = true;
    const transform = new THREE.Object3D();
    const place = (mesh, ring, scale, radius) => {
      for (let index = 0; index < 6; index += 1) {
        const angle = (index / 6) * Math.PI * 2;
        if (ring) transform.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.75 - 0.1, 0.2);
        else transform.position.set((index - 2.5) * 0.45, 0.85, 0);
        transform.rotation.set(index * 0.2, index * 0.3, 0);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(basic, false, 1, 0);
    place(lit, true, 0, 0.35);
    basic.frustumCulled = false;
    lit.frustumCulled = false;
    const group = new THREE.Group();
    group.add(lit);
    scene.add(basic, group);
    let frame = 0;
    return {
      render() {
        frame += 1;
        if (frame >= 10) {
          place(basic, true, 1, 0.8);
          place(lit, true, 1, 0.35);
        }
        return renderer.render(scene, camera);
      },
    };
  });
}
