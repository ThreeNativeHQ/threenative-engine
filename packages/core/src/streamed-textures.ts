import type { Mesh } from "three";

/** The material texture slots a model's images reach (glTF's own, plus the physical extensions). */
const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "bumpMap",
  "lightMap",
  "displacementMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "transmissionMap",
  "thicknessMap",
  "iridescenceMap",
  "specularColorMap",
  "specularIntensityMap",
] as const;

type SlottedMaterial = Record<string, unknown> & { needsUpdate?: boolean };

type Releasable = { dispose?: () => void };

/** Texture state a game sets after load (sampler, transform, tags); the whole file keeps it. */
const CARRIED = [
  "anisotropy",
  "wrapS",
  "wrapT",
  "magFilter",
  "minFilter",
  "colorSpace",
  "channel",
  "rotation",
  "matrixAutoUpdate",
  "userData",
] as const;
const CARRIED_VECTORS = ["offset", "repeat", "center", "matrix"] as const;

/** Gives `next` what the game set on `from`, so the swap changes the mips and nothing else. */
function carry(from: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const name of CARRIED) if (name in from) next[name] = from[name];
  for (const name of CARRIED_VECTORS)
    (next[name] as { copy?: (value: unknown) => void } | undefined)?.copy?.(from[name]);
}

const materialsOf = (mesh: Mesh | undefined): SlottedMaterial[] =>
  ([] as unknown[]).concat(mesh?.material).filter(Boolean) as SlottedMaterial[];

/**
 * PRD-860 Phase 2: the coarse model drew with each texture's resident mips; the full model parses
 * with the whole files. Call this at the coarse load: it records the textures the coarse model
 * brought. The returned function takes the full model's meshes when they land and puts the whole
 * texture in every slot that still holds a recorded one, on whatever material the mesh has now, so a
 * clone of the material takes it too while a texture or material the game set meanwhile stays. The
 * whole texture takes what the game set on the resident one (anisotropy, wrap, transform). It
 * releases the replaced resident textures and every full-model texture nothing took. With
 * `swap: false` (no resident mips were served, so the coarse textures are already whole) it only
 * releases the full model's copies. Returns how many slots swapped.
 */
export function streamedTextureUpgrade(
  coarse: readonly Mesh[],
): (full: readonly Mesh[], swap: boolean) => number {
  const loaded = coarse.map((mesh) =>
    materialsOf(mesh).map((material) => TEXTURE_SLOTS.map((name) => material[name])),
  );
  return (full, swap) => {
    const whole = new Map<Releasable, Releasable>();
    const unused = new Set<Releasable>();
    full.forEach((mesh, index) =>
      materialsOf(mesh).forEach((material, slot) =>
        TEXTURE_SLOTS.forEach((name, at) => {
          const next = material[name] as Releasable | null | undefined;
          const resident = loaded[index]?.[slot]?.[at] as Releasable | null | undefined;
          if (!next || next === resident) return;
          if (swap && resident) whole.set(resident, next);
          else unused.add(next);
        }),
      ),
    );
    const replaced = new Set<Releasable>();
    const taken = new Set<Releasable>();
    let swapped = 0;
    for (const mesh of whole.size > 0 ? coarse : [])
      for (const material of materialsOf(mesh)) {
        let changed = false;
        for (const name of TEXTURE_SLOTS) {
          const resident = material[name] as Releasable | null | undefined;
          const next = resident ? whole.get(resident) : undefined;
          if (resident === null || resident === undefined || next === undefined) continue;
          if (!taken.has(next))
            carry(resident as Record<string, unknown>, next as Record<string, unknown>);
          material[name] = next;
          replaced.add(resident);
          taken.add(next);
          swapped += 1;
          changed = true;
        }
        if (changed) material.needsUpdate = true;
      }
    for (const next of whole.values()) unused.add(next);
    for (const texture of replaced) texture.dispose?.();
    for (const texture of unused) if (!taken.has(texture)) texture.dispose?.();
    return swapped;
  };
}
