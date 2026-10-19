import type { AnimationComposer } from "@threenative/core";
import type { CharacterBody3D } from "@threenative/physics";
import { Quaternion, Vector3 } from "three";

/** The example's actual fixed-step caller. Rapier consumes the proposal before afterPhysics. */
export class CompositionCharacter {
  readonly #before = new Vector3();
  readonly #beforeRotation = new Quaternion();
  readonly #rotation = new Quaternion();
  readonly #accepted = new Vector3();
  readonly #up = new Vector3(0, 1, 0);
  #pendingIntent = false;
  ticks = 0;
  blockedTicks = 0;

  constructor(
    readonly animation: AnimationComposer,
    readonly body: CharacterBody3D,
    readonly beforePose: () => void = () => {},
    readonly afterPose: () => void = () => {},
  ) {}

  update(dt: number): void {
    this.#before.copy(this.body.object.position);
    this.#beforeRotation.copy(this.body.object.quaternion);
    const proposal = this.animation.advance(dt);
    // CharacterBody3D writes this orientation into the same bulk Rapier target as translation.
    this.#rotation.setFromAxisAngle(this.#up, proposal.yaw);
    this.body.object.quaternion.multiply(this.#rotation);
    this.body.move(proposal.translation);
    this.#pendingIntent = true;
  }

  afterPhysics(): void {
    // A synchronous scene transition can install this callback during the outgoing tick.
    if (!this.#pendingIntent) return;
    this.#accepted.copy(this.body.object.position).sub(this.#before);
    this.#rotation.copy(this.#beforeRotation).invert().multiply(this.body.object.quaternion);
    const yaw = 2 * Math.atan2(this.#rotation.y, this.#rotation.w);
    this.beforePose();
    this.animation.finish({ translation: this.#accepted, yaw });
    this.#pendingIntent = false;
    this.afterPose();
    this.ticks += 1;
    if (this.animation.blocked) this.blockedTicks += 1;
  }

  dispose(): void {
    this.#pendingIntent = false;
    this.animation.dispose();
    this.body.dispose();
  }
}
