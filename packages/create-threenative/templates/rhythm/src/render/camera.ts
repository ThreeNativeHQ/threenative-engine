// Generated for you. Camera framing is yours to edit.
//
// A fixed front view of the stage: both performers in frame, a little above their heads and tilted
// down, so the pads read and the bottom of the frame is left for the beat bar. The lens nudges toward the stage on each beat; the nudge is
// the pulse of `clock.ts`, so the picture breathes with the song.
import { type PerspectiveCamera, Vector3 } from "three";

const POSITION = new Vector3(0, 2.1, 8.4);
const AIM = new Vector3(0, 0.25, 0);
/** Metres the lens moves toward the stage at the top of a beat. */
const PUSH = 0.12;

export function createStageCamera(camera: PerspectiveCamera): (pulse: number) => void {
  camera.fov = 38;
  camera.updateProjectionMatrix();
  const frame = (pulse: number): void => {
    camera.position.set(POSITION.x, POSITION.y, POSITION.z - PUSH * pulse);
    camera.lookAt(AIM);
  };
  frame(0);
  return frame;
}
