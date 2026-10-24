import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ISnap,
  PAGE,
  finish,
  pace,
  pageData,
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

  describe("port rank", () => {
    const { rankScore, PORT } = pageData();
    const row = (vis: number, perf: number, cx: number) => ({ vis, perf, cx });

    it("ranks a cheap high-impact PRD above a costly low-impact one", () => {
      expect(rankScore(row(5, 4, 4))).toBeGreaterThan(rankScore(row(1, 0, 8)));
      expect(rankScore(row(3, 2, 4))).toBeGreaterThan(rankScore(row(3, 2, 8)));
      expect(rankScore(row(0, 3, 5))).toBeGreaterThan(rankScore(row(0, 1, 5)));
    });

    it("gives every PORT row a visual and a performance score from 0 to 5, and a unique rank to each open one", () => {
      const open = PORT.filter((p) => p.done < p.total);
      for (const p of PORT) {
        for (const k of ["vis", "perf"] as const) expect(p[k]).toBeGreaterThanOrEqual(0);
        for (const k of ["vis", "perf"] as const) expect(p[k]).toBeLessThanOrEqual(5);
        expect(["measured", "estimate"]).toContain(p.visSrc);
        expect(["measured", "estimate"]).toContain(p.perfSrc);
      }
      expect(new Set(open.map((p) => p.rank)).size).toBe(open.length);
      const byRank = [...open].sort((a, b) => a.rank - b.rank);
      const scores = byRank.map(rankScore);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });
  });

  describe("port waves", () => {
    const { PORT, PRDS } = pageData();
    const waitsOf = (p: { waits: string }): string[] =>
      p.waits === "—" ? [] : p.waits.split(",").map((w) => w.trim());

    it("puts every PRD in the same wave as the PRDs it waits on, or later", () => {
      const byId = new Map(PORT.map((p) => [p.id, p]));
      const late = PORT.flatMap((p) =>
        waitsOf(p).flatMap((w) => {
          const q = byId.get(w);
          return q && q.wave > p.wave
            ? [`${p.id} (wave ${p.wave}) waits on ${w} (wave ${q.wave})`]
            : [];
        }),
      );
      expect(late).toEqual([]);
    });

    it("names only PRDs that are on the port list or filed as done", () => {
      const byId = new Map(PORT.map((p) => [p.id, p]));
      const unknown = PORT.flatMap((p) =>
        waitsOf(p)
          .filter((w) => !byId.has(w) && PRDS[w]?.f !== "done")
          .map((w) => `${p.id} waits on ${w}`),
      );
      expect(unknown).toEqual([]);
    });

    it("has no wait cycle", () => {
      const byId = new Map(PORT.map((p) => [p.id, p]));
      const walk = (id: string, path: string[]): void => {
        expect(path, `cycle ${[...path, id].join(" > ")}`).not.toContain(id);
        for (const w of waitsOf(byId.get(id) ?? { waits: "—" })) walk(w, [...path, id]);
      };
      for (const p of PORT) walk(p.id, []);
    });

    it("counts a PRD filed under done/ as done and gives it no rank", () => {
      for (const p of PORT)
        if (PRDS[p.id]?.f === "done") expect([p.done >= p.total, p.rank]).toEqual([true, null]);
    });
  });

  it("reads only fields a PORT row has when it renders the port list", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "..", PAGE), "utf8");
    const part = page.slice(
      page.indexOf("// ---------- port order"),
      page.indexOf("// ---------- coverage explorer"),
    );
    const { PORT, PRDS } = pageData();
    // The block also totals boxes over the registry, whose entries use their own short keys.
    const keys = new Set([
      ...Object.keys(PORT[0] ?? {}),
      ...Object.keys(Object.values(PRDS)[0] ?? {}),
    ]);
    const read = [...part.matchAll(/\bp\.([A-Za-z]\w*)/g)].map((m) => m[1] as string);
    expect(read.length).toBeGreaterThan(20);
    expect(read.filter((k) => !keys.has(k))).toEqual([]);
  });
});
