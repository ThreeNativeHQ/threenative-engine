// Generated for you. Framing is a game-owned decision.
import type { PerspectiveCamera } from "three";

const followedCameras = new WeakSet<PerspectiveCamera>();

export function setupCamera(camera: PerspectiveCamera): void {
  followedCameras.delete(camera);
  camera.fov = 52;
  camera.near = 0.1;
  // Past the sea's own reach (`SURFACE.reach`). The far plane is what says where the world ends,
  // and if it ends closer than the water does, the horizon is a cut edge at 420 m with the sky
  // showing through above it.
  camera.far = 8_000;
  camera.position.set(5.2, 2.6, 6.4);
  camera.lookAt(0, 0.6, -2);
  camera.updateProjectionMatrix();
}

/**
 * Where the camera sits relative to the ship: astern, up, and a little out to starboard.
 *
 * The distance and the height are one decision, not two. At 7.4 m astern and 3.7 m up the lens was
 * 27 degrees above the water and the ship filled half the frame: its rail was at the bottom edge
 * and the player never saw the whole of what they were sailing. The shot this wants is a third
 * person chase — the whole ship, and a strip of sea ahead of the bow to steer by — and that is a
 * distance and a lens height together, because the aim point is what sets the horizon and the two
 * of them are not free. These three numbers put the horizon at about 235 px of 720, a little under
 * a third from the top, and the ship's masthead comfortably inside the frame.
 *
 * The height is raised rather than dropped for the sake of the ship's waterline. A lens near the
 * surface looks *along* the sea, and a 13 m swell running under a 4.3 m hull puts a trough either
 * side of every crest: from low down, the water immediately in front of the lens is often half a
 * metre below the hull's own waterline, the line of sight to the keel clears it, and the whole
 * bottom of the boat hangs in the air in front of the sea behind it.
 */
const CHASE = { astern: 8.8, height: 4.3, starboard: 2.3 } as const;
/** How far ahead of the bow the camera looks, so the next mark is in frame before it is reached. */
const LEAD = 5.2;
/** Where the lens looks, above the sea beside the hull. Together with the offset this is the horizon. */
const AIM = 1.9;
/** The least water the camera keeps under it, in metres. */
const FREEBOARD = 1.5;

/**
 * Follow from off the starboard quarter, near the water, **behind the bow**.
 *
 * The offset used to be a constant in world axes, which was fine while the ship could only travel
 * along -Z. Now that the helm turns the hull, a fixed offset means the camera watches the ship
 * from whatever side it has turned towards: sail west and the shot is the transom, sail east and
 * the bowsprit comes at the lens. Rotating the offset by the heading keeps the rig against the
 * sky, which is the shot this game is about.
 *
 * The position is eased and the aim point is not. Easing the aim as well makes the horizon lag
 * the turn and the whole frame swim; easing only the position gives the camera the weight of
 * something being towed astern while the ship stays where the player put it.
 */
export function followShip(
  camera: PerspectiveCamera,
  target: { x: number; y: number; z: number },
  heading: number,
  deltaTime: number,
  seaAtCamera: (x: number, z: number) => number,
): void {
  const forwardX = -Math.sin(heading);
  const forwardZ = -Math.cos(heading);
  const starboardX = Math.cos(heading);
  const starboardZ = -Math.sin(heading);
  const wantX = target.x - forwardX * CHASE.astern + starboardX * CHASE.starboard;
  const wantZ = target.z - forwardZ * CHASE.astern + starboardZ * CHASE.starboard;
  const wantY = target.y + CHASE.height;
  if (followedCameras.has(camera)) {
    const blend = Math.min(1, Math.max(0, deltaTime) * 3.6);
    camera.position.x += (wantX - camera.position.x) * blend;
    camera.position.y += (wantY - camera.position.y) * blend;
    camera.position.z += (wantZ - camera.position.z) * blend;
  } else {
    camera.position.set(wantX, wantY, wantZ);
    followedCameras.add(camera);
  }
  // Never below the sea it is looking at.
  //
  // The height offset is measured from the ship, and the ship is in a trough about half the time
  // — so a camera seven metres astern of a hull that has just dropped into one sits level with, or
  // inside, the crest between them. The frame then goes to a wall of water with a mast sticking
  // out of it, which reads as the renderer having failed rather than as a sea running. The
  // clearance is generous because a crest arriving between two frames has to clear it too.
  const floor = seaAtCamera(camera.position.x, camera.position.z) + FREEBOARD;
  if (camera.position.y < floor) camera.position.y = floor;
  camera.lookAt(target.x + forwardX * LEAD, target.y + AIM, target.z + forwardZ * LEAD);
}
