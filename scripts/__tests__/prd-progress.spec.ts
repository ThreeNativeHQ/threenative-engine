import { describe, expect, it } from "vitest";

import { progressOf, proofWarnings, readSections } from "../prd-progress.js";

/** The shape that caused the 2026-09-08 stall: acceptance boxes only, no phase boxes. */
const ACCEPTANCE_ONLY = `# PRD-365 — consumer desktop distribution

### Phase 1 — a game command creates a container

**Implementation and wiring:** prose only, no boxes.

## Acceptance criteria

- [ ] Each claimed desktop OS has a relocatable container.
- [ ] Signed Windows and notarized macOS artifacts are verified.
`;

const TWO_PHASES = `# PRD-x

### Phase 1 — first

- [x] wire the caller
- [x] required test green

### Phase 2 — second

- [ ] wire the caller
- [ ] required test green

## Acceptance criteria

- [ ] the whole thing works
`;

const FINISHED = TWO_PHASES.replaceAll("- [ ]", "- [x]");

/**
 * R6: work that is outside the author's reach lives under "## Blocked on" and is NOT a box that
 * counts toward progress. Here every countable box is ticked and the only open line is blocked.
 */
const BLOCKED_ONLY = `### Phase 1 — first

- [x] wire the caller. proof: \`pnpm test\`
- [x] required test green. proof: CI job \`unit\`

### Phase 2 — second

- [x] wire the caller. proof: \`pnpm test\`
- [x] required test green. proof: CI job \`unit\`

## Acceptance criteria

- [x] the whole thing works. proof: PR #1

## Blocked on

- [ ] A named physical device, on loan from the hardware owner.
- [ ] One owner call on the product name, 2026-09-25.
`;

/** R1: a box with no \`proof:\` marker is a warning, never a failure, so old PRDs still run. */
const MIXED_PROOF = `### Phase 1 — first

- [x] wire the caller. proof: \`pnpm test\`
- [x] required test green
- [ ] no proof marker either

## Acceptance criteria

- [x] the whole thing works. proof: PR #1
`;

describe("readSections", () => {
  it("should attribute boxes to the phase heading above them", () => {
    const sections = readSections(TWO_PHASES);
    const phases = sections.filter((section) => section.kind === "phase");
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ ticked: 2, total: 2 });
    expect(phases[1]).toMatchObject({ ticked: 0, total: 2 });
  });

  it("should keep acceptance boxes out of the phase tally", () => {
    const acceptance = readSections(TWO_PHASES).filter((s) => s.kind === "acceptance");
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]).toMatchObject({ ticked: 0, total: 1 });
  });
});

describe("progressOf", () => {
  it("should report zero phases for a PRD whose only boxes are acceptance criteria", () => {
    // The caller turns this into a non-zero exit; it must never be reported as progress.
    expect(progressOf(ACCEPTANCE_ONLY)).toMatchObject({ percent: 0, phases: 0 });
  });

  it("should exclude boxes under a Blocked on heading from the counts (R6)", () => {
    const progress = progressOf(BLOCKED_ONLY);
    expect(progress.phaseBoxes).toBe(4);
    expect(progress.phaseBoxesTicked).toBe(4);
    expect(progress.acceptanceTicked).toBe(1);
    expect(progress.label.name).toBe("prd:100% — ready");
  });

  it("should bucket one of two verified phases at 50% orange", () => {
    expect(progressOf(TWO_PHASES).label).toEqual({ color: "#e36209", name: "prd:50%" });
  });

  it("should count boxes rather than whole phases, so partial phases still register", () => {
    // Two phases, neither complete, but four of six boxes ticked: half built, not 0%.
    const partial = `### Phase 1 — a

- [x] one
- [x] two
- [ ] three

### Phase 2 — b

- [x] one
- [x] two
- [ ] three

## Acceptance criteria

- [ ] done
`;
    const progress = progressOf(partial);
    expect(progress.phasesComplete).toBe(0);
    expect(progress.phaseBoxesTicked).toBe(4);
    expect(progress.phaseBoxes).toBe(6);
    expect(progress.label).toEqual({ color: "#e36209", name: "prd:50%" });
  });

  it("should hold at 75% yellow while every phase is in but acceptance is open", () => {
    const phasesDone = TWO_PHASES.replace("- [ ] wire the caller", "- [x] wire the caller").replace(
      "- [ ] required test green",
      "- [x] required test green",
    );
    const progress = progressOf(phasesDone);
    expect(progress.phasesComplete).toBe(progress.phases);
    expect(progress.acceptanceTicked).toBeLessThan(progress.acceptanceTotal);
    expect(progress.label).toEqual({ color: "#fbca04", name: "prd:75%" });
  });

  it("should treat numbered implementation-order sections as phases", () => {
    // PRD-373 spells its phases "### 1. Select checks…" rather than "### Phase 1 — …".
    const numbered = `## Implementation order

### 1. Select checks from the diff

- [x] implemented and wired
- [ ] required test green

### 2. Wire selection into CI

- [ ] implemented and wired

## Acceptance checks

- [ ] the selector is right
`;
    const progress = progressOf(numbered);
    expect(progress.phases).toBe(2);
    expect(progress.phaseBoxesTicked).toBe(1);
    expect(progress.label.name).toBe("prd:25%");
  });

  it("should only reach 100% green when phases and acceptance are both ticked", () => {
    expect(progressOf(FINISHED).label).toEqual({ color: "#0e8a16", name: "prd:100% — ready" });
  });

  it("should read a numbered acceptance heading as acceptance criteria", () => {
    const numbered = FINISHED.replace("## Acceptance criteria", "## 7. Acceptance criteria");
    expect(progressOf(numbered).label.name).toBe("prd:100% — ready");
  });

  it("should refuse to reach 100% when a PRD has no acceptance criteria to satisfy", () => {
    const noAcceptance = FINISHED.slice(0, FINISHED.indexOf("## Acceptance criteria"));
    expect(progressOf(noAcceptance).percent).toBe(75);
  });
});

describe("proofWarnings", () => {
  it("should name every countable box without a proof: marker and ignore Blocked on boxes (R1)", () => {
    const warnings = proofWarnings(MIXED_PROOF);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("required test green");
    expect(warnings[1]).toContain("no proof marker either");
  });

  it("should return nothing when every countable box carries proof:", () => {
    expect(proofWarnings(BLOCKED_ONLY)).toEqual([]);
  });
});
