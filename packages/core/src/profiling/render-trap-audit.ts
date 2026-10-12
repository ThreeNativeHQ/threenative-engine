import { EquirectangularReflectionMapping, type Object3D } from "three";

/** Marker for an equirectangular environment below three's minimum PMREM cube size. */
export const ENVIRONMENT_TOO_SMALL_MARKER = "TN_ENVIRONMENT_TOO_SMALL";
/** Marker for a drawn material whose opacity three ignores. */
export const OPACITY_IGNORED_MARKER = "TN_OPACITY_IGNORED";

interface IRenderTrapMaterial {
  opacity?: number;
  transparent?: boolean;
  alphaHash?: boolean;
  visible?: boolean;
  name?: string;
  type?: string;
}

function opacityIgnored(
  material: IRenderTrapMaterial | undefined,
): material is IRenderTrapMaterial {
  return (
    material != null &&
    material.visible !== false &&
    typeof material.opacity === "number" &&
    material.opacity < 1 &&
    material.transparent !== true &&
    material.alphaHash !== true
  );
}

/** Structural reads only: Node materials, native adapters and test stubs share this audit. */
export function renderTrapAudit(scene: Object3D & { environment?: unknown }): string[] {
  const lines: string[] = [];
  const environment = scene.environment as
    | { isTexture?: boolean; mapping?: number; image?: { width?: number } }
    | null
    | undefined;
  const width = environment?.image?.width;
  // three r185 derives PMREM's cube size from width / 4; LOD_MIN = 4 requires 16 px.
  if (
    environment?.isTexture === true &&
    environment.mapping === EquirectangularReflectionMapping &&
    typeof width === "number" &&
    width / 4 < 16
  ) {
    lines.push(
      `${ENVIRONMENT_TOO_SMALL_MARKER}:${JSON.stringify({ width })} use an equirectangular environment at least 64 pixels wide for PMREM`,
    );
  }

  const materials = new Set<IRenderTrapMaterial>();
  const examples: string[] = [];
  scene.traverseVisible((object) => {
    const drawable = object as Object3D & {
      isMesh?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      isSprite?: boolean;
      material?: IRenderTrapMaterial | IRenderTrapMaterial[];
    };
    if (!(drawable.isMesh || drawable.isPoints || drawable.isLine || drawable.isSprite)) return;
    const slot = drawable.material;
    for (const material of Array.isArray(slot) ? slot : [slot]) {
      if (!opacityIgnored(material) || materials.has(material)) continue;
      materials.add(material);
      if (examples.length < 5) examples.push(material.name || material.type || "unnamed material");
    }
  });
  if (materials.size > 0) {
    lines.push(
      `${OPACITY_IGNORED_MARKER}:${JSON.stringify({ materials: materials.size, examples })} set transparent: true or alphaHash: true on these materials so opacity takes effect`,
    );
  }
  return lines;
}
