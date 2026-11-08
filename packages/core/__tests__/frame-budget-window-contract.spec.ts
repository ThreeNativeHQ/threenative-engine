// `threenative-playtest perf` reads the window `frame-budget.ts` writes. The reader's type lives in
// the playtest protocol (core treats playtest as an optional peer, so it cannot import it at run
// time), and this spec holds the writer's type assignable to it: a field renamed on either side
// fails the typecheck instead of printing an empty perf report.
import type { IFrameBudgetWindowJson } from "@threenative/playtest/protocol";
import { describe, expectTypeOf, it } from "vitest";

import type { IFrameBudgetWindow } from "../src/frame-budget.js";

describe("the frame-budget window contract", () => {
  it("should write every field the perf reader declares", () => {
    expectTypeOf<IFrameBudgetWindow>().toExtend<IFrameBudgetWindowJson>();
  });
});
