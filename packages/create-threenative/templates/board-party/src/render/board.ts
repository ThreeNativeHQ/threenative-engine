// The board and the arena, built from the tables in `board/layout.ts`. The scene syncs them to the match
// each tick: a space takes the material of its type, the star floats above the live space, and the
// arena shows the set of the minigame that is running.
import { BoxGeometry, CylinderGeometry, Group, type Material, Mesh, PlaneGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CHAINS, type ISpace, lookahead, spaceAt } from "../board/layout.js";
import { DASH_FINISH_X, DASH_START_X } from "../minigames/dash.js";
import { ARENA } from "../minigames/minigame.js";
import { ROPE_REACH } from "../minigames/rope.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import {
  createDie,
  createStar,
  goldMaterial,
  greenLamp,
  redLamp,
  redMaterial,
  usedMaterial,
} from "./props.js";

const SPACE_RADIUS = 1.05;
const SPACE_HEIGHT = 0.14;
/** The height a pawn stands at: the top of a space disc. */
export const SURFACE = SPACE_HEIGHT;

const MATERIAL: Readonly<Record<ISpace["type"], Material>> = {
  blue: propMaterial,
  red: redMaterial,
  star: goldMaterial,
  start: structureMaterial,
  used: usedMaterial,
};

export interface IBoardView {
  readonly root: Group;
  readonly star: Group;
  readonly die: Mesh;
  /** The bar of the rope game, a pivot at the arena centre. */
  readonly bar: Group;
  /** Show the set of the minigame that runs ("" for none) and set the start lamp. */
  readonly showMinigame: (id: string, go: boolean) => void;
  /** Retype the discs from the match's space records. */
  readonly sync: (spaces: readonly ISpace[]) => void;
}

function strip(width: number, height: number, depth: number, x: number, y: number, z: number) {
  return worldGridUVs(new BoxGeometry(width, height, depth).translate(x, y, z));
}

export function createBoard(spaces: readonly ISpace[]): IBoardView {
  const root = new Group();
  root.name = "board";
  const floor = new Mesh(
    worldGridUVs(new PlaneGeometry(220, 220).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  floor.receiveShadow = true;
  root.add(floor);

  // The paths: one strip per link of every chain, merged into one draw.
  const links: BoxGeometry[] = [];
  const seen = new Set<string>();
  for (const [chain, { ids }] of CHAINS.entries())
    for (let slot = 0; slot < ids.length; slot += 1) {
      const from = spaces[spaceAt({ chain, slot })] as ISpace;
      const to = spaces[spaceAt(lookahead({ chain, slot }))] as ISpace;
      const key = `${from.id}-${to.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const link = new BoxGeometry(length, 0.08, 0.7);
      link.rotateY(-Math.atan2(to.z - from.z, to.x - from.x));
      link.translate((from.x + to.x) / 2, 0.04, (from.z + to.z) / 2);
      links.push(worldGridUVs(link));
    }
  const paths = new Mesh(mergeGeometries(links, false), structureMaterial);
  paths.receiveShadow = true;
  root.add(paths);

  const discGeometry = new CylinderGeometry(SPACE_RADIUS, SPACE_RADIUS, SPACE_HEIGHT, 28);
  discGeometry.translate(0, SPACE_HEIGHT / 2, 0);
  const startGeometry = worldGridUVs(discGeometry.clone());
  const discs = spaces.map((space) => {
    const disc = new Mesh(
      space.base === "start" ? startGeometry : discGeometry,
      MATERIAL[space.type],
    );
    disc.position.set(space.x, 0, space.z);
    disc.castShadow = true;
    disc.receiveShadow = true;
    disc.name = `space.${space.id}`;
    root.add(disc);
    return disc;
  });

  // The arena: a slab, then one set per minigame.
  const slab = new Mesh(strip(26, 0.3, 14, ARENA.x, -0.15, ARENA.z), structureMaterial);
  slab.receiveShadow = true;
  root.add(slab);
  const dash = new Group();
  dash.name = "dash-set";
  for (let lane = 0; lane < 4; lane += 1) {
    const laneMesh = new Mesh(
      strip(DASH_FINISH_X - DASH_START_X + 2, 0.04, 2, 0, 0.02, ARENA.z + (1.5 - lane) * 2.4),
      floorMaterial,
    );
    laneMesh.receiveShadow = true;
    dash.add(laneMesh);
  }
  for (const x of [DASH_START_X, DASH_FINISH_X]) {
    const line = new Mesh(
      new BoxGeometry(0.2, 0.06, 9.8).translate(x, 0.05, ARENA.z),
      propMaterial,
    );
    dash.add(line);
  }
  const lamp = new Mesh(new CylinderGeometry(0.35, 0.35, 0.3, 20), redLamp);
  lamp.position.set(DASH_START_X - 1.6, 2.2, ARENA.z);
  const post = new Mesh(new CylinderGeometry(0.06, 0.06, 2.2, 8), structureMaterial);
  post.position.set(DASH_START_X - 1.6, 1.1, ARENA.z);
  dash.add(lamp, post);
  dash.visible = false;
  root.add(dash);

  const rope = new Group();
  rope.name = "rope-set";
  const hub = new Mesh(new CylinderGeometry(0.3, 0.3, 0.5, 20), propMaterial);
  hub.position.set(ARENA.x, 0.25, ARENA.z);
  const bar = new Group();
  bar.position.set(ARENA.x, 0.2, ARENA.z);
  const arm = new Mesh(new BoxGeometry(ROPE_REACH, 0.14, 0.3), redMaterial);
  arm.position.x = ROPE_REACH / 2;
  arm.castShadow = true;
  bar.add(arm);
  rope.add(hub, bar);
  for (let seat = 0; seat < 4; seat += 1) {
    const theta = Math.PI / 2 + (seat * Math.PI) / 2;
    const mark = new Mesh(new CylinderGeometry(0.7, 0.7, 0.06, 20), propMaterial);
    mark.position.set(ARENA.x + 3.2 * Math.cos(theta), 0.03, ARENA.z + 3.2 * Math.sin(theta));
    rope.add(mark);
  }
  rope.visible = false;
  root.add(rope);

  const star = createStar();
  const die = createDie();
  root.add(star, die);

  return {
    root,
    star,
    die,
    bar,
    showMinigame: (id, go) => {
      dash.visible = id === "dash";
      rope.visible = id === "rope";
      lamp.material = go ? greenLamp : redLamp;
    },
    sync: (current) => {
      for (const [index, disc] of discs.entries())
        disc.material = MATERIAL[(current[index] as ISpace).type];
    },
  };
}
