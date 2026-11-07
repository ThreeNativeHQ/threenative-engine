// Generated for you. Own converted materials; preserve borrowed and authored assignments.
import { Material, Mesh, MeshStandardMaterial, type Scene } from "three";
import { type IBacklightControls, backlightMaterial } from "./backlightMaterial.js";
interface IMaterialAssignment {
  readonly mesh: Mesh;
  readonly original: Mesh["material"];
  applied?: Mesh["material"];
  slots?: readonly Material[];
}
export function createMaterialAssignments(scene: Scene, controls: IBacklightControls) {
  const assignments: IMaterialAssignment[] = [];
  const converted = new Map<MeshStandardMaterial, ReturnType<typeof backlightMaterial>>();
  const originalOf = new Map<Material, MeshStandardMaterial>();
  const exclusions: string[] = [];
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    assignments.push({ mesh: object, original: object.material });
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const reason = unsupported(material);
      if (reason !== undefined)
        exclusions.push(
          `${object.name || object.type}:${material.name || material.type}:${reason}`,
        );
    }
  });
  function unsupported(material: Material): string | undefined {
    if (!(material instanceof MeshStandardMaterial) || material.type !== "MeshStandardMaterial")
      return "unsupported material type";
    if (
      material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
      material.customProgramCacheKey !== Material.prototype.customProgramCacheKey
    )
      return "custom shader requires separate qualification";
    return undefined;
  }
  function convert(material: Material): Material {
    if (unsupported(material) !== undefined) return material;
    const standard = material as MeshStandardMaterial;
    let owned = converted.get(standard);
    if (owned === undefined) {
      owned = backlightMaterial(standard, controls);
      converted.set(standard, owned);
      originalOf.set(owned, standard);
    }
    return owned;
  }
  function restore(assignment: IMaterialAssignment): void {
    const current = assignment.mesh.material;
    if (current === assignment.applied) {
      const unchanged =
        !Array.isArray(current) ||
        (current.length === assignment.slots?.length &&
          current.every((material, index) => material === assignment.slots?.[index]));
      if (unchanged) {
        assignment.mesh.material = assignment.original;
        return;
      }
    }
    // Preserve authored array edits/replacements, but never leave an owned conversion attached.
    if (Array.isArray(current)) {
      const restored = current.map((material) => originalOf.get(material) ?? material);
      if (restored.some((material, index) => material !== current[index]))
        assignment.mesh.material = restored;
    } else assignment.mesh.material = originalOf.get(current) ?? current;
  }
  function applyAssignment(assignment: IMaterialAssignment): void {
    // The game's later material override wins; never overwrite it on a tier recovery.
    if (assignment.mesh.material !== assignment.original) return;
    if (Array.isArray(assignment.original)) {
      // Borrowed arrays may be edited in place during a fallback. Read their current slots.
      const slots = assignment.original.map(convert);
      assignment.applied = slots.some(
        (material, index) => material !== (assignment.original as Material[])[index],
      )
        ? slots
        : assignment.original;
      assignment.slots = [...slots];
    } else if (assignment.applied === undefined) {
      assignment.applied = convert(assignment.original);
    }
    assignment.mesh.material = assignment.applied;
  }
  return {
    setEnabled(enabled: boolean): void {
      for (const assignment of assignments) {
        if (enabled) applyAssignment(assignment);
        else restore(assignment);
      }
    },
    debug: () => ({
      convertedMaterials: converted.size,
      excludedSlots: exclusions.length,
      exclusions,
    }),
    dispose(): void {
      for (const assignment of assignments) restore(assignment);
      for (const material of converted.values()) material.dispose();
      converted.clear();
      originalOf.clear();
    },
  };
}
