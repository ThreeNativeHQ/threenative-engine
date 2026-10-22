import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../unreal-look/judge.js";
import {
  type IRegionMeasure,
  capAtFar,
  regionTable,
  sceneOfFrame,
} from "../unreal-look/judgeRegions.js";
import {
  type IFrame,
  type IJudgeRun,
  buildPrompt,
  collectFrames,
} from "../unreal-look/judgeVerdict.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (closeness: ("MATCH" | "CLOSE" | "FAR")[], overall: "MATCH" | "CLOSE" | "FAR") =>
  ({
    frames: closeness.map((vsUnreal, i) => ({
      id: `shadow/wildwood/L7/pose${i}`,
      verdict: "NEUTRAL",
      vsUnreal,
      reasons: "r",
      differences: "",
    })),
    overall: { verdict: "NEUTRAL", vsUnreal: overall, reasons: "r" },
    model: "m",
    sessionId: "s",
    costUsd: 0,
    durationMs: 0,
    imagesRead: 0,
  }) as IJudgeRun;
const row = (frame: string, region: string, after: number[]): IRegionMeasure => ({
  frame: `shadow/wildwood/L7/${frame}`,
  region,
  unrealP50: 60,
  before: after.map(() => 0.1),
  after,
});

describe("capAtFar", () => {
  it("caps a frame at FAR when any region is past the limit, whatever the judge said", () => {
    const rows = [
      row("pose0", "GreenTree_1", [0.5, 0.6]),
      row("pose0", "Floor", [0.01, 0.01]),
      row("pose1", "Floor", [0.01, 0.01]),
    ];
    const { judged, capped } = capAtFar(run(["CLOSE", "CLOSE"], "CLOSE"), rows, 0.25);
    expect(judged.frames.map((f) => f.vsUnreal)).toEqual(["FAR", "CLOSE"]);
    expect(capped.get("shadow/wildwood/L7/pose0")).toEqual(["GreenTree_1"]);
  });

  it("caps the round at FAR when a frame was capped, and leaves a round with no break alone", () => {
    const over = capAtFar(
      run(["CLOSE", "MATCH"], "CLOSE"),
      [row("pose0", "Bush_1", [0.3]), row("pose1", "Floor", [0.01])],
      0.25,
    );
    expect(over.judged.overall.vsUnreal).toBe("FAR");
    const fine = capAtFar(
      run(["CLOSE", "MATCH"], "CLOSE"),
      [row("pose0", "Bush_1", [0.2]), row("pose1", "Floor", [0.01])],
      0.25,
    );
    expect(fine.judged.frames.map((f) => f.vsUnreal)).toEqual(["CLOSE", "MATCH"]);
    expect(fine.judged.overall.vsUnreal).toBe("CLOSE");
    expect(fine.capped.size).toBe(0);
  });

  it("judges a region by the mean of the AFTER runs, so one outlier run does not decide", () => {
    const rows = [row("pose0", "GreenTree_1", [0.1, 0.5])];
    expect(capAtFar(run(["CLOSE"], "CLOSE"), rows, 0.25).capped.size).toBe(1);
    expect(capAtFar(run(["CLOSE"], "CLOSE"), rows, 0.31).capped.size).toBe(0);
  });

  it("fails closed on a frame with no measured region and on a region with no AFTER run", () => {
    expect(() => capAtFar(run(["CLOSE"], "CLOSE"), [], 0.25)).toThrow(/REGIONS_MISSING.*pose0/);
    expect(() => capAtFar(run(["CLOSE"], "CLOSE"), [row("pose0", "Floor", [])], 0.25)).toThrow(
      /REGIONS_MISSING/,
    );
  });
});

describe("regionTable", () => {
  it("lists every region with its Unreal median, the dP50 of each run and the OVER mark", () => {
    const text = regionTable(
      [row("pose0", "GreenTree_1", [0.5, 0.6]), row("pose0", "Floor", [0.01, 0.02])],
      0.25,
    );
    expect(text).toMatch(/limit 0\.25/);
    expect(text).toMatch(/shadow\/wildwood\/L7\/pose0.*GreenTree_1.*60.*0\.50.*0\.60.*OVER/s);
    const floor = text.split("\n").find((line) => line.includes("Floor")) as string;
    expect(floor).toMatch(/0\.01/);
    expect(floor).not.toMatch(/OVER/);
  });

  it("goes into the prompt when given", () => {
    const frames: IFrame[] = [];
    expect(buildPrompt("C", frames, "TABLE-OF-REGIONS")).toContain("TABLE-OF-REGIONS");
    expect(buildPrompt("C", frames)).not.toContain("TABLE-OF-REGIONS");
  });
});

describe("sceneOfFrame", () => {
  it("reads the scene, the layer folder and the pose from a capture path", () => {
    expect(sceneOfFrame("/r", "/r/shadow/wildwood/L7/sun15-closeup.png")).toEqual({
      scene: "shadow:wildwood",
      layer: "L7",
      pose: "sun15-closeup",
    });
    expect(sceneOfFrame("/r", "/r/sunlit-room/L7-medium/sun60-window.png")).toEqual({
      scene: "sunlit-room",
      layer: "L7-medium",
      pose: "sun60-window",
    });
  });
  it("refuses a frame that is not under a scene folder", () => {
    expect(() => sceneOfFrame("/r", "/r/L7/a.png")).toThrow(/REGIONS_SCENE/);
  });
});

describe("main --region-limit", () => {
  const PIXEL = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), "unreal-look-judge-regions-"));
    roots.push(root);
    for (const set of ["b1", "b2", "a1", "a2", "u"]) {
      const file = path.join(root, set, "shadow/wildwood/L7/sun60-closeup.png");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, PIXEL);
    }
    writeFileSync(path.join(root, "criteria.md"), "C1 crown within 0.25.\n");
    const argv = (extra: string[]) => [
      "--criteria",
      path.join(root, "criteria.md"),
      ...["b1", "b2"].flatMap((d) => ["--before", path.join(root, d)]),
      ...["a1", "a2"].flatMap((d) => ["--after", path.join(root, d)]),
      "--unreal",
      path.join(root, "u"),
      "--out",
      path.join(root, "verdict.json"),
      ...extra,
    ];
    return { root, argv };
  }
  const id = "shadow/wildwood/L7/sun60-closeup";
  const answer = (images: string[]) => {
    const lines = [JSON.stringify({ type: "system", subtype: "init", model: "m" })];
    images.forEach((file, i) => {
      const content = [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: file } }];
      lines.push(JSON.stringify({ type: "assistant", message: { content } }));
    });
    const frames = [{ id, verdict: "NEUTRAL", vsUnreal: "CLOSE", reasons: "r", differences: "" }];
    const output = {
      frames,
      overall: { verdict: "NEUTRAL", vsUnreal: "CLOSE", reasons: "r" },
      unreadable: [],
    };
    lines.push(JSON.stringify({ type: "result", subtype: "success", structured_output: output }));
    return lines;
  };
  const measured: IRegionMeasure[] = [row("sun60-closeup", "GreenTree_1", [0.4, 0.4])];

  it("hands the numbers to the judge and caps the frame the judge called CLOSE", async () => {
    const { root, argv } = setup();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const images = collectFrames({
      before: ["b1", "b2"].map((d) => path.join(root, d)),
      after: ["a1", "a2"].map((d) => path.join(root, d)),
      unreal: path.join(root, "u"),
    }).flatMap((f) => [...f.before, ...f.after, f.unreal]);
    const session = vi.fn(async (_: { prompt: string }) => answer(images));
    const measure = vi.fn(() => measured);
    const code = await main(argv(["--region-limit", "0.25"]), session, measure);
    expect(code).toBe(0);
    expect(session.mock.calls[0]?.[0].prompt).toMatch(/GreenTree_1.*OVER/s);
    const file = JSON.parse(readFileSync(path.join(root, "verdict.json"), "utf8"));
    expect(file.regionLimit).toBe(0.25);
    expect(file.frames[0]).toMatchObject({ vsUnreal: "FAR", judgedVsUnreal: "CLOSE" });
    expect(file.frames[0].overRegions).toEqual(["GreenTree_1"]);
    expect(file.overall.vsUnreal).toBe("FAR");
  });

  it("leaves the judge's closeness alone and measures nothing without the flag", async () => {
    const { root, argv } = setup();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const images = collectFrames({
      before: ["b1", "b2"].map((d) => path.join(root, d)),
      after: ["a1", "a2"].map((d) => path.join(root, d)),
      unreal: path.join(root, "u"),
    }).flatMap((f) => [...f.before, ...f.after, f.unreal]);
    const measure = vi.fn(() => measured);
    await main(argv([]), async () => answer(images), measure);
    expect(measure).not.toHaveBeenCalled();
    const file = JSON.parse(readFileSync(path.join(root, "verdict.json"), "utf8"));
    expect(file.frames[0].vsUnreal).toBe("CLOSE");
    expect(file.regionLimit).toBeUndefined();
  });

  it("refuses a limit that is not a positive number", async () => {
    const { argv } = setup();
    await expect(main(argv(["--region-limit", "x"]), async () => [])).rejects.toThrow(
      /BAD_INPUT.*--region-limit/,
    );
  });

  it("fails closed, with no session, when the regions cannot be measured", async () => {
    const { root, argv } = setup();
    const session = vi.fn(async () => []);
    const measure = () => {
      throw new Error("TN_UNREAL_LOOK_MISSING_CELL: no ID frame");
    };
    await expect(main(argv(["--region-limit", "0.25"]), session, measure)).rejects.toThrow(
      /MISSING_CELL/,
    );
    expect(session).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(root, "verdict.json"), "utf8")).status).toBe("FAILED");
  });
});
