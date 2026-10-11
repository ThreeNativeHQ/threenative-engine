import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";

// core's mergeParts lists a part's channels with Object.keys(geometry.attributes) and reads each
// one back with getAttribute: every geometry class, not only BufferGeometry, must list real names.
const custom = new BufferGeometry();
custom.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
custom.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
custom.setIndex([0, 1, 2]);
custom.computeVertexNormals();
const shape = new Shape();
shape.moveTo(0, 0);
shape.lineTo(1, 0);
shape.lineTo(0, 1);
const curve = new CatmullRomCurve3([
  new Vector3(0, 0, 0),
  new Vector3(1, 1, 0),
  new Vector3(2, 0, 1),
]);
const geometries: [string, BufferGeometry][] = [
  ["custom", custom],
  ["box", new BoxGeometry(1, 1, 1)],
  ["sphere", new SphereGeometry(1, 8, 6)],
  ["cylinder", new CylinderGeometry(1, 1, 2, 8)],
  ["tube", new TubeGeometry(curve, 8, 0.1, 6)],
  ["torus", new TorusGeometry(1, 0.2, 6, 8)],
  ["extrude", new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })],
];
for (const [label, geometry] of geometries) {
  const names = Object.keys(geometry.attributes).sort();
  const missing = names.filter((name) => geometry.getAttribute(name) === null);
  console.log(label, names.join(","), "missing", missing.length);
}
