// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The mill keep on the headland, and the wooden arrow sign at the path's fork, from primitives: the
// sandstone walls and the wooden shingle roofs take the photo textures in `assets/` (`tex-*.webp`)
// (surface.ts); a green sprout in relief over the door, a windmill on the corner tower whose sails
// turn on the GPU, and the teal flag with the hero's leaf painted in code; the arched doorway glows
// warm. Every part of one material is merged into one geometry, so the whole keep costs eight draws.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  TorusGeometry,
} from "three";
import { cos, positionLocal, sin, time, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { paintedTexture } from "./materials.js";
import { C } from "./palette.js";
import { type ISurfaces, masonryMaterial, texturedMaterial } from "./surface.js";

const hex = (color: number): [number, number, number] => [
  ((color >> 16) & 255) / 255,
  ((color >> 8) & 255) / 255,
  (color & 255) / 255,
];

/** The flag: a teal field and a cream leaf, the hero's own badge. */
function flagMap(): ReturnType<typeof paintedTexture> {
  const teal = hex(C.cap);
  const cream = hex(C.button);
  return paintedTexture(
    64,
    40,
    (x, y) => {
      const u = (x - 30) / 16;
      const v = (y - 20) / 16;
      const lu = u * 0.8 + v * 0.6;
      const lv = -u * 0.6 + v * 0.8;
      return Math.abs(lu) < 1 && Math.abs(lv) < 0.42 * (1 - lu * lu) ? cream : teal;
    },
    true,
  );
}

/** UVs from world-aligned planes, `tile` metres per repeat, chosen by each vertex's normal. */
export function planarUv(geometry: BufferGeometry, tile: number): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const position = g.attributes.position;
  const normal = g.attributes.normal;
  const count = position?.count ?? 0;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const x = position?.getX(i) ?? 0;
    const y = position?.getY(i) ?? 0;
    const z = position?.getZ(i) ?? 0;
    const nx = Math.abs(normal?.getX(i) ?? 0);
    const ny = Math.abs(normal?.getY(i) ?? 0);
    const nz = Math.abs(normal?.getZ(i) ?? 0);
    const [u, v] = ny > nx && ny > nz ? [x, z] : nx > nz ? [z, y] : [x, y];
    uv.set([u / tile, v / tile], i * 2);
  }
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  return g;
}

/** UVs wrapped round a cylinder or cone about its own axis, `tile` metres per repeat. */
export function wrapUv(geometry: BufferGeometry, radius: number, tile: number): BufferGeometry {
  const uv = geometry.attributes.uv;
  const position = geometry.attributes.position;
  for (let i = 0; i < (uv?.count ?? 0); i += 1) {
    uv?.setXY(
      i,
      ((uv.getX(i) ?? 0) * Math.PI * 2 * radius) / tile,
      (position?.getY(i) ?? 0) / tile,
    );
  }
  return geometry.index === null ? geometry : geometry.toNonIndexed();
}

/** One geometry from many non-indexed parts that share position, normal and uv (and color, if all have it). */
function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const merged = new BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) {
    if (!parts.every((part) => part.attributes[name] !== undefined)) continue;
    const size = parts[0]?.attributes[name]?.itemSize ?? 3;
    const total = parts.reduce((sum, part) => sum + (part.attributes[name]?.count ?? 0), 0);
    const data = new Float32Array(total * size);
    let offset = 0;
    for (const part of parts) {
      const attribute = part.attributes[name];
      if (attribute === undefined) continue;
      for (let i = 0; i < attribute.count; i += 1) {
        for (let c = 0; c < size; c += 1)
          data[(offset + i) * size + c] = attribute.getComponent(i, c);
      }
      offset += attribute.count;
    }
    merged.setAttribute(name, new BufferAttribute(data, size));
  }
  return merged;
}

/** The windmill tower: x, z, radius, wall top, cap height, sail length from the hub. */
const MILL = { x: -12.5, z: -2.5, radius: 3.2, top: 13, cap: 3.5, sail: 7 } as const;

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

/**
 * A gable roof as one prism: ridge along X (or along Z with `alongZ`), eaves at `y0`, ridge at `y1`,
 * over the footprint [x0, x1] x [z0, z1]. Returns the two sloped planes and the two gable ends.
 */
function gable(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  alongZ = false,
): { slopes: BufferGeometry; ends: BufferGeometry } {
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [
    ...a,
    ...b,
    ...c,
    ...a,
    ...c,
    ...d,
  ];
  const s = (p: number[]): number[] => (alongZ ? [p[2] ?? 0, p[1] ?? 0, p[0] ?? 0] : p);
  // Built along X, then swizzled: [x, y, z] -> [z, y, x] when the ridge runs along Z.
  const [a0, a1, b0, b1] = alongZ ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
  const mid = (b0 + b1) / 2;
  const slopes = new BufferGeometry();
  slopes.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        ...quad(s([a0, y0, b1]), s([a1, y0, b1]), s([a1, y1, mid]), s([a0, y1, mid])),
        ...quad(s([a1, y0, b0]), s([a0, y0, b0]), s([a0, y1, mid]), s([a1, y1, mid])),
      ]),
      3,
    ),
  );
  const ends = new BufferGeometry();
  ends.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        ...s([a0, y0, b0]),
        ...s([a0, y0, b1]),
        ...s([a0, y1, mid]),
        ...s([a1, y0, b1]),
        ...s([a1, y0, b0]),
        ...s([a1, y1, mid]),
      ]),
      3,
    ),
  );
  for (const g of [slopes, ends]) g.computeVertexNormals();
  // Mirrored swizzle flips the winding; flip it back so the faces point out.
  if (alongZ) {
    for (const g of [slopes, ends]) {
      const p = g.attributes.position;
      for (let i = 0; i < (p?.count ?? 0); i += 3) {
        if (p === undefined) continue;
        const [x, y, z] = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
        p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
        p.setXYZ(i + 2, x, y, z);
      }
      g.computeVertexNormals();
    }
  }
  return { ends, slopes };
}

/** An arch panel (a rectangle under a half disc), facing +Z, its base centre at the origin. */
function archPanel(width: number, height: number): BufferGeometry {
  const radius = width / 2;
  // Subdivided: `glow` paints per vertex, and a one-quad panel has vertices only at the jambs.
  const rect = new PlaneGeometry(width, height - radius, 8, 6).translate(
    0,
    (height - radius) / 2,
    0,
  );
  const top = new CircleGeometry(radius, 16, 0, Math.PI).translate(0, height - radius, 0);
  return merge([rect.toNonIndexed(), top.toNonIndexed()]);
}

/**
 * Warm light inside a doorway or window: unlit vertex colours, bright at the floor's centre and
 * dark at the jambs, a deep amber just above 1 so the lit room reads warm behind the arch in full
 * sun (a brighter glow tone-maps to a flat cream).
 */
function glow(geometry: BufferGeometry, width: number): BufferGeometry {
  const position = geometry.attributes.position;
  const colors = new Float32Array((position?.count ?? 0) * 3);
  for (let i = 0; i < (position?.count ?? 0); i += 1) {
    const x = (position?.getX(i) ?? 0) / (width / 2);
    const y = position?.getY(i) ?? 0;
    const k = Math.max(
      0.12,
      (1 - 0.8 * Math.min(1, Math.abs(x))) * (1 - 0.8 * Math.min(1, y / (width * 1.6))),
    );
    colors.set([1.5 * k, 0.68 * k, 0.22 * k], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** A pointed leaf in the XY plane, its stalk at the origin, `length` along +Y, `depth` deep along +Z. */
function leaf(length: number, depth: number): BufferGeometry {
  const w = length * 0.36;
  const outline = new Shape()
    .moveTo(0, 0)
    .quadraticCurveTo(w, length * 0.45, 0, length)
    .quadraticCurveTo(-w, length * 0.45, 0, 0);
  return new ExtrudeGeometry(outline, { bevelEnabled: false, curveSegments: 8, depth });
}

/**
 * The keep, its origin at the foot of its front door, facing +Z: a hall with a gable roof, a gabled
 * gatehouse with a sprout in relief over the door, a windmill on the corner tower with the flag on
 * its cap, and a small back turret. `stone` is solid; the roofs, sails, relief and flag are not.
 */
export function buildCastle(s: ISurfaces, footY: number): { group: Group; stone: Mesh } {
  const group = new Group();
  group.name = "castle";
  const stoneParts: BufferGeometry[] = [];
  const roofParts: BufferGeometry[] = [];
  const glowParts: BufferGeometry[] = [];
  const addStone = (g: BufferGeometry) => stoneParts.push(planarUv(g, 4));

  // Hall, gatehouse and the gatehouse's gable wall, sunk a metre so no seam shows on a slope.
  addStone(box(-11, -1, -12, 11, 9, -2));
  addStone(box(-4.5, -1, -3, 4.5, 13, 0));
  const hallRoof = gable(-11, 11, -12.6, -1.4, 9, 14);
  roofParts.push(planarUv(hallRoof.slopes, 2.5));
  addStone(hallRoof.ends);
  const gateRoof = gable(-5.1, 5.1, -3.2, 0, 13, 17, true);
  roofParts.push(planarUv(gateRoof.slopes, 2.5));
  addStone(gateRoof.ends);
  // A plinth course and a string course: two stone bands that read as weight and as storeys.
  addStone(box(-11.3, -1, -12.3, 11.3, 0.6, -1.7));
  addStone(box(-4.8, 8.6, -3.3, 4.8, 9.1, 0.3));
  // Towers: x, z, radius, wall top, roof height. The first is the windmill: a low cap, sails in front.
  for (const [x, z, radius, top, roof] of [
    [MILL.x, MILL.z, MILL.radius, MILL.top, MILL.cap],
    [11.5, -11.5, 2.4, 13, 6],
  ] as const) {
    stoneParts.push(
      wrapUv(
        new CylinderGeometry(radius, radius * 1.08, top + 1, 20, 1, true).translate(
          0,
          (top - 1) / 2,
          0,
        ),
        radius,
        4,
      ).translate(x, 0, z),
    );
    stoneParts.push(
      wrapUv(
        new CylinderGeometry(radius + 0.35, radius + 0.35, 0.6, 20).translate(0, top - 0.3, 0),
        radius,
        4,
      ).translate(x, 0, z),
    );
    roofParts.push(
      wrapUv(
        new ConeGeometry(radius + 0.6, roof, 20, 1, true).translate(0, top + roof / 2, 0),
        radius,
        2.5,
      ).translate(x, 0, z),
    );
    glowParts.push(glow(archPanel(0.9, 1.8), 0.9).translate(x, top - 5, z + radius + 0.06));
  }
  // The arched door with its stone voussoirs, and the windows of the hall.
  glowParts.push(glow(archPanel(3.6, 4.6), 3.6).translate(0, 0, 0.03));
  stoneParts.push(
    planarUv(new TorusGeometry(1.95, 0.32, 6, 16, Math.PI).translate(0, 2.8, 0.05), 4),
  );
  for (const x of [-8.5, -6, 6, 8.5]) {
    glowParts.push(glow(archPanel(1.2, 2.4), 1.2).translate(x, 3, -1.97));
    stoneParts.push(planarUv(box(x - 0.8, 2.75, -1.95, x + 0.8, 3, -1.6), 4));
  }

  const stone = new Mesh(merge(stoneParts), masonryMaterial(s, footY));
  stone.name = "castle-stone";
  const wood = texturedMaterial(s, "planks", { doubleSided: true });
  const roofs = new Mesh(merge(roofParts), wood);
  const light = new Mesh(merge(glowParts), new MeshBasicMaterial({ vertexColors: true }));
  // The sprout over the door: a stem and two leaves standing proud of the gable wall.
  const sproutParts = [
    new BoxGeometry(0.3, 2.4, 0.22).translate(0, 10.4, 0.11).toNonIndexed(),
    leaf(2.6, 0.24).rotateZ(0.75).translate(0, 11, 0),
    leaf(2.3, 0.24).rotateZ(-0.7).translate(0, 10.6, 0),
  ];
  const sprout = new Mesh(
    merge(sproutParts),
    new MeshStandardMaterial({ color: C.leaf, roughness: 0.6 }),
  );
  // The sails: four lattice arms on a hub before the tower, turned about the hub's axis on the GPU.
  const spin = time.mul(0.45);
  const turned = vec3(
    positionLocal.x.mul(cos(spin)).sub(positionLocal.y.mul(sin(spin))),
    positionLocal.x.mul(sin(spin)).add(positionLocal.y.mul(cos(spin))),
    positionLocal.z,
  );
  const spars: BufferGeometry[] = [
    planarUv(new CylinderGeometry(0.55, 0.55, 1.2, 10).rotateX(Math.PI / 2), 2),
  ];
  const cloth: BufferGeometry[] = [];
  for (let arm = 0; arm < 4; arm += 1) {
    const a = (arm * Math.PI) / 2;
    spars.push(planarUv(box(-0.14, 0.4, 0.4, 0.14, MILL.sail, 0.62), 2).rotateZ(a));
    cloth.push(planarUv(box(0.14, 1.5, 0.5, 1.6, MILL.sail - 0.3, 0.56), 2).rotateZ(a));
  }
  const sparMaterial = new MeshStandardNodeMaterial({ map: wood.map, roughness: 0.85 });
  sparMaterial.positionNode = turned;
  const clothMaterial = new MeshStandardNodeMaterial({
    color: C.button,
    roughness: 0.9,
    side: DoubleSide,
  });
  clothMaterial.positionNode = turned;
  const hub = [MILL.x, MILL.top + 0.4, MILL.z + MILL.radius + 0.7] as const;
  const sails = new Group();
  sails.name = "mill-sails";
  sails.position.set(...hub);
  sails.add(new Mesh(merge(spars), sparMaterial), new Mesh(merge(cloth), clothMaterial));
  for (const mesh of [stone, roofs, sprout, ...(sails.children as Mesh[])]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(stone, roofs, light, sprout, sails);

  // The flag on the windmill's cap, waving from the pole.
  const capTop = MILL.top + MILL.cap;
  const pole = new Mesh(
    new CylinderGeometry(0.07, 0.09, 4, 6).translate(MILL.x, capTop + 1.5, MILL.z),
    wood,
  );
  pole.castShadow = true;
  const flagMaterial = new MeshStandardNodeMaterial({
    map: flagMap(),
    roughness: 0.8,
    side: DoubleSide,
  });
  const along = positionLocal.x.add(1.25).max(0);
  flagMaterial.positionNode = positionLocal.add(
    vec3(
      0,
      sin(time.mul(3.1).add(along.mul(2.2)))
        .mul(along)
        .mul(0.06),
      sin(time.mul(4).add(along.mul(2.6)))
        .mul(along)
        .mul(0.22),
    ),
  );
  const flag = new Mesh(new PlaneGeometry(2.5, 1.55, 10, 4), flagMaterial);
  flag.position.set(MILL.x + 1.3, capTop + 2.6, MILL.z);
  flag.castShadow = true;
  group.add(pole, flag);
  return { group, stone };
}

/** A wooden arrow sign on a post, its origin at the post's foot, pointing along +X. */
export function buildSignpost(s: ISurfaces): Group {
  const sign = new Group();
  sign.name = "signpost";
  const wood = texturedMaterial(s, "planks");
  // Planar UVs at 2 m a tile: the board shows a plank and a half with its grain along the arrow.
  const post = new Mesh(planarUv(new BoxGeometry(0.16, 1.5, 0.16).translate(0, 0.75, 0), 2), wood);
  const board = new Mesh(
    planarUv(new BoxGeometry(1.1, 0.34, 0.07).translate(0.45, 1.25, 0.1), 2),
    wood,
  );
  // The arrow's head: a wedge as wide as the board is tall plus a lip, so it reads at 10 m.
  const tip = new Mesh(
    planarUv(
      new CylinderGeometry(0.3, 0.3, 0.07, 3)
        .rotateX(Math.PI / 2)
        .rotateZ(-Math.PI / 2)
        .translate(1.12, 1.25, 0.1),
      2,
    ),
    wood,
  );
  for (const mesh of [post, board, tip]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    sign.add(mesh);
  }
  return sign;
}
