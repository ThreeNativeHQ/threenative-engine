import type { WorldCells } from "@threenative/core/world";

/** Consumer preparation only; the worlds still own admission, residency and prewarm. */
export interface IPropPreparationProgress {
  readonly phase:
    | "grounding"
    | "partition"
    | "bounds"
    | "models"
    | "records"
    | "world-load"
    | "complete";
  readonly bucket: string;
  readonly added: number;
  readonly total: number;
  readonly worlds: readonly WorldCells[];
  /** Live promise settlements, distinct from load completion and the last rendered counters. */
  readonly prewarmedWorlds: number;
}
