import { describe, expect, it } from "vitest";
import {
  type ISnap,
  finish,
  pace,
  readPrd,
  squarify,
  updateHistory,
} from "../unreal-port-status.js";

describe("unreal-port-status", () => {
  it("squarify tiles the whole rectangle in proportion to each value", () => {
    const cells = squarify([6, 6, 4, 3, 2, 2, 1], (v) => v, { x0: 0, y0: 0, x1: 6, y1: 4 });
    const area = (c: (typeof cells)[number]): number =>
      (c.rect.x1 - c.rect.x0) * (c.rect.y1 - c.rect.y0);
    expect(cells.reduce((a, c) => a + area(c), 0)).toBeCloseTo(24);
    for (const c of cells) expect(area(c)).toBeCloseTo(c.item);
  });

  it("reads the title, status and ticked boxes of a PRD", () => {
    const prd = readPrd(
      "docs/PRDs/done/PRD-123-x.md",
      "# PRD-123 — A frame is fast\n\n**Status:** PARTIAL\n\n- [x] one\n  - [X] two\n- [ ] three\n",
    );
    expect(prd).toMatchObject({ t: "A frame is fast", s: "PARTIAL", d: 2, n: 3, f: "done" });
  });

  const snap = (date: string, done: number, total = 100): ISnap => ({
    date,
    done,
    total,
    lookDone: 0,
    lookTotal: 0,
    open: 1,
  });

  it("adds a history point only when the counts change, and replaces a same-day point", () => {
    const h = [snap("2026-10-01", 10)];
    expect(updateHistory(h, snap("2026-10-05", 10))).toEqual(h);
    expect(updateHistory(h, snap("2026-10-05", 12))).toHaveLength(2);
    expect(updateHistory(h, snap("2026-10-01", 12))).toEqual([snap("2026-10-01", 12)]);
  });

  it("projects the finish from the pace of the last two weeks", () => {
    const h = [snap("2026-09-01", 0), snap("2026-10-01", 20), snap("2026-10-15", 40)];
    expect(pace(h)).toBeCloseTo(10);
    expect(finish(h, 60, pace(h))).toBe("2026-11-26");
    expect(finish(h, 60, 0)).toBeNull();
  });
});
