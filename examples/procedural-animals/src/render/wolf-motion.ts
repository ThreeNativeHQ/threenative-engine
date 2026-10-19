import type { IAnimalMotionContext } from "@threenative/procedural-animals";
import { createQuadrupedMotion } from "./donor/core/motion/quadruped.js";
import { motion } from "./donor/species/wolf/motion.js";

// This editable source contains only the pinned wolf's motion closure: no registry,
// generation, SDF meshing, worker, Node imports, shell/fins/eye renderer or Mixer.
export const wolfMotion = (context: IAnimalMotionContext) =>
  createQuadrupedMotion({ ...context, species: { motion } });
