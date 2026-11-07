// Generated for you. Own converted materials; preserve borrowed and authored assignments.
import { Material, Mesh, MeshStandardMaterial, type Object3D, type Scene } from "three";
import { type IBacklightControls, backlightMaterial } from "./backlightMaterial.js";
interface IMaterialAssignment {
  readonly mesh: Mesh;
  readonly original: Mesh["material"];
  applied?: Mesh["material"];
  slots?: readonly Material[];
  readonly owned: Set<MeshStandardMaterial>;
  readonly exclusions: string[];
}
export function createMaterialAssignments(scene: Scene, controls: IBacklightControls) {
  const assignments = new Map<Mesh, IMaterialAssignment>();
  const references = new Map<MeshStandardMaterial, number>();
  let enabled = false;
  let disposed = false;
  const converted = new Map<MeshStandardMaterial, ReturnType<typeof backlightMaterial>>();
  const originalOf = new Map<Material, MeshStandardMaterial>();
  function enroll(root: Object3D): void {
    if (disposed) return;
    root.traverse((object) => {
      if (!(object instanceof Mesh) || assignments.has(object)) return;
      const assignment: IMaterialAssignment = {
        mesh: object,
        original: object.material,
        owned: new Set(),
        exclusions: [],
      };
      assignments.set(object, assignment);
      assignment.exclusions.push(...excludedSlots(object));
      if (enabled) applyAssignment(assignment);
    });
  }
  function release(root: Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const assignment = assignments.get(object);
      if (assignment === undefined) return;
      restore(assignment);
      assignments.delete(object);
      for (const source of assignment.owned) releaseConversion(source);
    });
  }
  function excludedSlots(mesh: Mesh): string[] {
    const slots = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return slots.flatMap((material) => {
      const reason = unsupported(material);
      return reason === undefined
        ? []
        : [`${mesh.name || mesh.type}:${material.name || material.type}:${reason}`];
    });
  }
  function releaseConversion(source: MeshStandardMaterial): void {
    const remaining = (references.get(source) ?? 1) - 1;
    if (remaining > 0) {
      references.set(source, remaining);
      return;
    }
    const material = converted.get(source);
    if (material !== undefined) {
      material.dispose();
      originalOf.delete(material);
    }
    references.delete(source);
    converted.delete(source);
  }
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
  function convert(material: Material, assignment: IMaterialAssignment): Material {
    if (unsupported(material) !== undefined) return material;
    const standard = material as MeshStandardMaterial;
    let owned = converted.get(standard);
    if (owned === undefined) {
      owned = backlightMaterial(standard, controls);
      converted.set(standard, owned);
      originalOf.set(owned, standard);
    }
    if (!assignment.owned.has(standard)) {
      assignment.owned.add(standard);
      references.set(standard, (references.get(standard) ?? 0) + 1);
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
      const slots = assignment.original.map((material) => convert(material, assignment));
      assignment.applied = slots.some(
        (material, index) => material !== (assignment.original as Material[])[index],
      )
        ? slots
        : assignment.original;
      assignment.slots = [...slots];
    } else if (assignment.applied === undefined) {
      assignment.applied = convert(assignment.original, assignment);
    }
    assignment.mesh.material = assignment.applied;
  }
  enroll(scene);
  return {
    enroll,
    release,
    setEnabled(requested: boolean): void {
      if (disposed) return;
      enabled = requested;
      for (const assignment of assignments.values()) {
        if (enabled) applyAssignment(assignment);
        else restore(assignment);
      }
    },
    debug: () => ({
      convertedMaterials: converted.size,
      enrolledMeshes: assignments.size,
      excludedSlots: [...assignments.values()].reduce(
        (sum, value) => sum + value.exclusions.length,
        0,
      ),
      exclusions: [...assignments.values()].flatMap((value) => value.exclusions),
    }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const assignment of assignments.values()) restore(assignment);
      assignments.clear();
      references.clear();
      for (const material of converted.values()) material.dispose();
      converted.clear();
      originalOf.clear();
    },
  };
}
