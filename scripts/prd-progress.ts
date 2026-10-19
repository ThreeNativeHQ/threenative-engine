/**
 * Computes the `prd:<n>%` progress label for a PRD from its own checkboxes.
 *
 * The bucket is driven by *verified* phases, never by lines written: a phase counts once every box
 * under its heading is ticked. Acceptance criteria are counted separately, because a PRD whose
 * phases are all in but whose acceptance boxes are open is not ready — it is 75%.
 *
 * Usage: `pnpm prd:progress docs/PRDs/<batch>/PRD-<id>-<slug>.md`
 */
import { readFileSync } from "node:fs";

export interface IPrdLabel {
  readonly name: string;
  readonly color: string;
}

export interface IPrdProgress {
  readonly phases: number;
  readonly phasesComplete: number;
  readonly phaseBoxes: number;
  readonly phaseBoxesTicked: number;
  readonly acceptanceTotal: number;
  readonly acceptanceTicked: number;
  readonly percent: 0 | 25 | 50 | 75 | 100;
  readonly label: IPrdLabel;
}

/** Red through yellow to green, one bucket per quarter. */
const LABELS: ReadonlyMap<number, IPrdLabel> = new Map([
  [0, { color: "#d73a4a", name: "prd:0%" }],
  [25, { color: "#d73a4a", name: "prd:25%" }],
  [50, { color: "#e36209", name: "prd:50%" }],
  [75, { color: "#fbca04", name: "prd:75%" }],
  [100, { color: "#0e8a16", name: "prd:100% — ready" }],
]);

/** "### Phase 2 — …" and the numbered "### 3. …" form used under an Implementation order heading. */
const PHASE_HEADING = /^#{3,4}\s+(?:Phase\b|\d+\.\s)/iu;
const ACCEPTANCE_HEADING = /^#{2,4}\s+(?:\d+\.\s+)?Acceptance criteria\b/iu;
const BLOCKED_HEADING = /^#{2,4}\s+Blocked on\b/iu;
const ANY_HEADING = /^#{2,4}\s/u;
const BOX = /^\s*[-*]\s+\[([ xX])\]/u;
const PROOF = /proof:/iu;

interface ISection {
  readonly kind: "phase" | "acceptance" | "blocked" | "other";
  total: number;
  ticked: number;
  /** Countable boxes here that name no `proof:` marker — a warning, never a failure. */
  unproven: string[];
}

/** Splits a PRD into phase / acceptance / other sections and tallies the boxes in each. */
export function readSections(markdown: string): readonly ISection[] {
  const sections: ISection[] = [];
  let current: ISection = { kind: "other", ticked: 0, total: 0, unproven: [] };
  sections.push(current);
  for (const line of markdown.split("\n")) {
    if (ANY_HEADING.test(line)) {
      const kind = PHASE_HEADING.test(line)
        ? "phase"
        : ACCEPTANCE_HEADING.test(line)
          ? "acceptance"
          : BLOCKED_HEADING.test(line)
            ? "blocked"
            : "other";
      current = { kind, ticked: 0, total: 0, unproven: [] };
      sections.push(current);
      continue;
    }
    const box = BOX.exec(line);
    if (box === null) continue;
    // R6: "## Blocked on" lines are not boxes that count — they are named dependencies.
    if (current.kind === "blocked") continue;
    current.total += 1;
    if (box[1] !== " ") current.ticked += 1;
    if (!PROOF.test(line)) current.unproven.push(line.trim());
  }
  return sections;
}

/** R1: countable boxes that name no proof, for a warning line per box in `main`. */
export function proofWarnings(markdown: string): readonly string[] {
  return readSections(markdown).flatMap((section) => section.unproven);
}

/** A PRD with no phase boxes at all cannot report progress — that is the shape this repo rejects. */
export function progressOf(markdown: string): IPrdProgress {
  const sections = readSections(markdown);
  const phases = sections.filter((section) => section.kind === "phase" && section.total > 0);
  const acceptance = sections.filter((section) => section.kind === "acceptance");
  const acceptanceTotal = acceptance.reduce((sum, section) => sum + section.total, 0);
  const acceptanceTicked = acceptance.reduce((sum, section) => sum + section.ticked, 0);
  const phasesComplete = phases.filter((section) => section.ticked === section.total).length;
  // Bucket on boxes, not whole phases: a PRD with every phase four-sixths done is half built, and
  // reporting it as 0% is the same discouraging lie that stalled the production-readiness batch.
  const phaseBoxes = phases.reduce((sum, section) => sum + section.total, 0);
  const phaseBoxesTicked = phases.reduce((sum, section) => sum + section.ticked, 0);

  const ready =
    phases.length > 0 &&
    phasesComplete === phases.length &&
    acceptanceTotal > 0 &&
    acceptanceTicked === acceptanceTotal;

  let percent: IPrdProgress["percent"];
  if (ready) percent = 100;
  else if (phases.length === 0) percent = 0;
  else {
    const ratio = phaseBoxes === 0 ? 0 : phaseBoxesTicked / phaseBoxes;
    percent = ratio >= 1 ? 75 : ratio >= 0.75 ? 75 : ratio >= 0.5 ? 50 : ratio > 0 ? 25 : 0;
  }

  const label = LABELS.get(percent);
  if (label === undefined) throw new Error(`no label for ${percent}%`);
  return {
    acceptanceTicked,
    acceptanceTotal,
    label,
    percent,
    phaseBoxes,
    phaseBoxesTicked,
    phases: phases.length,
    phasesComplete,
  };
}

function main(): void {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write("usage: pnpm prd:progress <path to PRD.md>\n");
    process.exit(1);
  }
  const markdown = readFileSync(file, "utf8");
  const progress = progressOf(markdown);
  if (progress.phases === 0) {
    process.stderr.write(
      `${file}: no phase checkboxes. Give each phase its own boxes before asking for a progress label.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `${file}\n` +
      `  phases     ${progress.phasesComplete}/${progress.phases} complete` +
      ` (${progress.phaseBoxesTicked}/${progress.phaseBoxes} boxes)\n` +
      `  acceptance ${progress.acceptanceTicked}/${progress.acceptanceTotal} ticked\n` +
      `  label      ${progress.label.name}  ${progress.label.color}\n`,
  );
  // R1: warn, never fail — an old PRD without proof markers must still report progress.
  for (const warning of proofWarnings(markdown)) {
    process.stderr.write(`${file}: warning: box names no \`proof:\` — ${warning}\n`);
  }
}

if (process.argv[1]?.endsWith("prd-progress.ts") === true) main();
