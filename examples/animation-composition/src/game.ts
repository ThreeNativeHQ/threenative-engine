import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { CompositionCourse } from "./course.js";

const game = defineGame<Record<string, unknown>, IPhysicsContext>({
  initialState: {},
  input: {
    forward: { keys: ["KeyW"] },
    strafe: { keys: ["KeyD"] },
    run: { keys: ["ShiftLeft"] },
    reload: { keys: ["KeyR"] },
    fire: { keys: ["KeyF"] },
    cancel: { keys: ["KeyC"] },
    freeze: { keys: ["KeyP"] },
    reset: { keys: ["Space"] },
    lifecycle: { keys: ["KeyL"] },
  },
  plugins: [rapier({ gravity: { x: 0, y: 0, z: 0 } }), playtest()],
  render: { preferWebGPU: true },
  seed: 446,
  step: 1 / 60,
  scenes: { course: CompositionCourse },
  start: "course",
});

export default game;
