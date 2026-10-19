import type { IAnimalMotion, IAnimalMotionContext } from "@threenative/procedural-animals";
export function createQuadrupedMotion(
  context: IAnimalMotionContext & { readonly species: { readonly motion: object } },
): IAnimalMotion;
