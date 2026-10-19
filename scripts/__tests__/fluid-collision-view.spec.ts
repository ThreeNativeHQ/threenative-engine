import { expect, test } from "vitest";
import { createParticleView } from "../../examples/prd476-fluid-particles/src/collision-proof.js";
import { FluidParticles3D } from "../../packages/core/src/fluid-particles.js";

test("the visible particle uses the solver's physical collision radius", () => {
  const water = new FluidParticles3D({ capacity: 1, spacing: 0.3 });
  const view = createParticleView(water);
  try {
    expect(view.geometry.type).toBe("SphereGeometry");
    expect(view.geometry.parameters.radius).toBeCloseTo(water.spacing * 0.44, 12);
    expect(view.material.isMeshLambertNodeMaterial).toBe(true);
    expect(view.material.positionNode).toBeDefined();
    expect(view.frustumCulled).toBe(false);
  } finally {
    view.geometry.dispose();
    view.material.dispose();
    water.detach();
  }
});
