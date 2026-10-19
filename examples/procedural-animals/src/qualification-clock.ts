const MILESTONES = [2, 4.5, 11, 24.5] as const;
/** Capture latency cannot move the requested pose or camera; existing input releases each hold. */
export class QualificationClock {
  elapsed = 0;
  #milestone = 0;
  #outside = false;
  get held() {
    return this.elapsed === MILESTONES[this.#milestone];
  }
  get outside() {
    return this.#outside;
  }
  advance(dt: number, ready: boolean, next: boolean, outside: boolean) {
    if (!Number.isFinite(dt) || dt <= 0) throw new Error("TN_ANIMAL_QUALIFICATION_DT");
    if (!ready) return;
    if (outside) {
      if (this.#milestone !== MILESTONES.length - 1 || !this.held)
        throw new Error("TN_ANIMAL_QUALIFICATION_PREMATURE_OUTSIDE");
      this.#outside = true;
    }
    if (next && this.held && this.#milestone < MILESTONES.length - 1) this.#milestone++;
    this.elapsed = Math.min(this.elapsed + dt, MILESTONES[this.#milestone] ?? 24.5);
  }
}
