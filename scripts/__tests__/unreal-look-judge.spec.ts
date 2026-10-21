import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeArgs, main } from "../unreal-look/judge.js";
import {
  CLOSENESS,
  type IFrame,
  VERDICTS,
  blockedBy,
  buildPrompt,
  collectFrames,
  readJudgeStream,
} from "../unreal-look/judgeVerdict.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PIXEL = PNG.sync.write(new PNG({ width: 1, height: 1 }));
/** One temp folder per test; `put("before1", "L9/a.png")` writes a PNG there. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "unreal-look-judge-"));
  roots.push(root);
  const put = (set: string, ...files: string[]) => {
    for (const file of files) {
      const target = path.join(root, set, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, PIXEL);
    }
  };
  const sets = (before = ["before1", "before2"], after = ["after1", "after2"]) => ({
    before: before.map((name) => path.join(root, name)),
    after: after.map((name) => path.join(root, name)),
    unreal: path.join(root, "unreal"),
  });
  return { root, put, sets };
}
/** Every set holds the same frames; Unreal lists its own spelling of the layer folder. */
function filled(files: string[], unreal = files) {
  const f = fixture();
  for (const set of ["before1", "before2", "after1", "after2"]) f.put(set, ...files);
  f.put("unreal", ...unreal);
  return f;
}

describe("collectFrames", () => {
  it("pairs frames of two runs per arm with the Unreal frame and keeps extra Unreal frames out", () => {
    const f = filled(["L9/L9_sun60_exterior.png", "L9/L9_sun60_spheres.png"]);
    f.put("unreal", "L7/L7_sun60_exterior.png", "L9/notes.txt");
    const frames = collectFrames(f.sets());
    expect(frames.map((frame) => [frame.id, frame.layer])).toEqual([
      ["L9/L9_sun60_exterior", "L9"],
      ["L9/L9_sun60_spheres", "L9"],
    ]);
    const first = frames[0] as IFrame;
    expect(first.before).toEqual([
      path.join(f.root, "before1/L9/L9_sun60_exterior.png"),
      path.join(f.root, "before2/L9/L9_sun60_exterior.png"),
    ]);
    expect(first.after).toHaveLength(2);
    expect(first.unreal).toBe(path.join(f.root, "unreal/L9/L9_sun60_exterior.png"));
  });

  it("pairs a GI frame with the Unreal variant it is judged against and skips the other variants", () => {
    const f = filled(
      ["sunlit-room/L7/sun60-window.png"],
      [
        "sunlit-room/L7-Epic/sun60-window.png",
        "sunlit-room/L7-Medium/sun60-window.png",
        "sunlit-room/L7-Epic-indirect/sun60-window.png",
      ],
    );
    const [frame] = collectFrames(f.sets());
    expect(frame?.id).toBe("sunlit-room/L7/sun60-window");
    expect(frame?.unreal).toBe(path.join(f.root, "unreal/sunlit-room/L7-Epic/sun60-window.png"));
    expect(frame?.unrealName).toBe("L7-Epic");
  });

  it("pairs ThreeNative L6 (shadows and AO, no GI) with Unreal L7 at Low (GI off)", () => {
    const f = filled(
      ["sunlit-room/L6/sun60-window.png"],
      ["sunlit-room/L7-Low/sun60-window.png", "sunlit-room/L7-Epic/sun60-window.png"],
    );
    const [frame] = collectFrames(f.sets());
    expect(frame?.layer).toBe("L6");
    expect(frame?.unrealName).toBe("L7-Low");
  });

  it("refuses ThreeNative L6 beside an Unreal full-look frame (the owner's 2026-10-21 sheet)", () => {
    const f = filled(["L6/L6_sun60_exterior.png"], ["L9/L9_sun60_exterior.png"]);
    expect(() => collectFrames(f.sets())).toThrow(
      /LAYER_MISMATCH.*unreal.*L9\/L9_sun60_exterior.*L6/s,
    );
  });

  it("refuses ThreeNative L6 beside Unreal L7 with GI on", () => {
    const f = filled(["sunlit-room/L6/x.png"], ["sunlit-room/L7-Epic/x.png"]);
    expect(() => collectFrames(f.sets())).toThrow(/LAYER_MISMATCH/);
  });

  it("refuses a BEFORE and an AFTER set at different layers", () => {
    const f = fixture();
    f.put("before1", "L6/x.png");
    f.put("before2", "L6/x.png");
    f.put("after1", "L9/x.png");
    f.put("after2", "L9/x.png");
    f.put("unreal", "L6/x.png", "L9/x.png");
    expect(() => collectFrames(f.sets())).toThrow(/LAYER_MISMATCH/);
  });

  it("refuses a frame whose path names no layer, or two", () => {
    const none = filled(["window.png"]);
    expect(() => collectFrames(none.sets())).toThrow(/LAYER_UNKNOWN.*window\.png/);
    const two = filled(["L6/L9_x.png"]);
    expect(() => collectFrames(two.sets())).toThrow(/LAYER_AMBIGUOUS.*L6 and L9/);
  });

  it("refuses a frame missing from any run, from AFTER or from UNREAL", () => {
    const run2 = filled(["L9/a.png", "L9/b.png"]);
    rmSync(path.join(run2.root, "before2/L9/b.png"));
    expect(() => collectFrames(run2.sets())).toThrow(/MISSING_FRAME.*before run 2.*L9\/b/s);
    const unreal = filled(["L9/a.png", "L9/b.png"]);
    rmSync(path.join(unreal.root, "unreal/L9/b.png"));
    expect(() => collectFrames(unreal.sets())).toThrow(/MISSING_FRAME.*unreal.*L9\/b/s);
    const extra = filled(["L9/a.png"]);
    extra.put("after2", "L9/c.png");
    extra.put("unreal", "L9/c.png");
    expect(() => collectFrames(extra.sets())).toThrow(/MISSING_FRAME.*before run 1.*L9\/c/s);
  });

  it("asks for two runs per arm, and for different folders per run", () => {
    const f = filled(["L9/a.png"]);
    expect(() => collectFrames(f.sets(["before1"], ["after1", "after2"]))).toThrow(
      /TOO_FEW_RUNS.*--before has 1/,
    );
    expect(() => collectFrames(f.sets(["before1", "before1"]))).toThrow(/same folder twice/);
    expect(collectFrames(f.sets(["before1"], ["after1"]), 1)).toHaveLength(1);
  });

  it("refuses a missing folder and a folder with no PNG", () => {
    const f = filled(["L9/a.png"]);
    expect(() => collectFrames({ ...f.sets(), unreal: path.join(f.root, "nope") })).toThrow(
      /BAD_INPUT.*not a folder/,
    );
    mkdirSync(path.join(f.root, "empty"));
    expect(() => collectFrames({ ...f.sets(), unreal: path.join(f.root, "empty") })).toThrow(
      /BAD_INPUT.*no PNG/,
    );
  });

  it("refuses two files that name one frame in one set", () => {
    const f = filled(["L9/a.png"], ["L9/a.png", "L9-Epic/a.png"]);
    expect(() => collectFrames(f.sets())).toThrow(/AMBIGUOUS_FRAME/);
  });

  it("follows a symlinked frame and caps the round at 24 frames", () => {
    const f = filled(["L9/a.png"]);
    symlinkSync(path.join(f.root, "before1/L9/a.png"), path.join(f.root, "before1/L9/b.png"));
    f.put("before2", "L9/b.png");
    f.put("after1", "L9/b.png");
    f.put("after2", "L9/b.png");
    f.put("unreal", "L9/b.png");
    expect(collectFrames(f.sets()).map((frame) => frame.id)).toEqual(["L9/a", "L9/b"]);
    const many = filled(Array.from({ length: 25 }, (_, i) => `L9/f${i}.png`));
    expect(() => collectFrames(many.sets())).toThrow(/TOO_MANY_FRAMES.*25/);
  });
});

function frame(id: string, layer = "L9"): IFrame {
  return {
    id,
    layer,
    before: [`/w/b1/${id}.png`, `/w/b2/${id}.png`],
    after: [`/w/a1/${id}.png`, `/w/a2/${id}.png`],
    unreal: `/w/u/${id}.png`,
    unrealName: `${layer}-Epic`,
  };
}
const two = [frame("L9/a"), frame("L9/b")];
const everyImage = two.flatMap((f) => [...f.before, ...f.after, f.unreal]);
const goodOutput = () => ({
  frames: [
    {
      id: "L9/a",
      verdict: "IMPROVEMENT",
      vsUnreal: "CLOSE",
      reasons: "wall is smoother",
      differences: "tint",
    },
    { id: "L9/b", verdict: "NEUTRAL", vsUnreal: "MATCH", reasons: "same", differences: "" },
  ],
  overall: { verdict: "IMPROVEMENT", vsUnreal: "CLOSE", reasons: "grain is gone" },
  unreadable: [] as string[],
});

/** The lines `claude -p --output-format stream-json` prints: init, one Read per image, the result. */
function stream(
  options: {
    reads?: string[];
    failed?: string[];
    output?: unknown;
    result?: Record<string, unknown>;
  } = {},
): string[] {
  const reads = options.reads ?? everyImage;
  const lines = [JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5" })];
  reads.forEach((file, i) => {
    const content = [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: file } }];
    lines.push(JSON.stringify({ type: "assistant", message: { content } }));
    const done = {
      type: "tool_result",
      tool_use_id: `t${i}`,
      is_error: options.failed?.includes(file) ?? false,
    };
    lines.push(JSON.stringify({ type: "user", message: { content: [done] } }));
  });
  const output = "output" in options ? options.output : goodOutput();
  lines.push(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      total_cost_usd: 0.41,
      duration_ms: 90_000,
      session_id: "s1",
      ...(output === undefined ? {} : { structured_output: output }),
      ...options.result,
    }),
  );
  return lines;
}

describe("readJudgeStream", () => {
  it("returns one verdict per frame, in frame order, with the model and cost", () => {
    const run = readJudgeStream(stream(), two);
    expect(run.frames.map((f) => [f.id, f.verdict, f.vsUnreal])).toEqual([
      ["L9/a", "IMPROVEMENT", "CLOSE"],
      ["L9/b", "NEUTRAL", "MATCH"],
    ]);
    expect(run.overall).toMatchObject({ verdict: "IMPROVEMENT", vsUnreal: "CLOSE" });
    expect(run.model).toBe("claude-sonnet-5-5");
    expect(run.costUsd).toBe(0.41);
    expect(run.imagesRead).toBe(everyImage.length);
  });

  it("accepts the verdict as fenced JSON in the result text when there is no structured output", () => {
    const text = `Here it is:\n\`\`\`json\n${JSON.stringify(goodOutput())}\n\`\`\``;
    const lines = stream({ output: undefined, result: { result: text } });
    expect(readJudgeStream(lines, two).overall.verdict).toBe("IMPROVEMENT");
  });

  it("fails closed when the session did not finish, or said it failed", () => {
    expect(() => readJudgeStream(stream().slice(0, -1), two)).toThrow(/NO_RESULT/);
    expect(() => readJudgeStream([], two)).toThrow(/NO_RESULT/);
    expect(() =>
      readJudgeStream(stream({ result: { is_error: true, result: "API Error" } }), two),
    ).toThrow(/JUDGE_FAILED.*API Error/);
    expect(() =>
      readJudgeStream(
        stream({ result: { subtype: "error_max_budget_usd", is_error: false } }),
        two,
      ),
    ).toThrow(/JUDGE_FAILED.*error_max_budget_usd/);
  });

  it("fails closed on output it cannot parse", () => {
    const prose = stream({ output: undefined, result: { result: "Both look fine to me." } });
    expect(() => readJudgeStream(prose, two)).toThrow(/UNPARSEABLE/);
    const broken = stream({ output: undefined, result: { result: "```json\n{ not json\n```" } });
    expect(() => readJudgeStream(broken, two)).toThrow(/UNPARSEABLE/);
    expect(() => readJudgeStream(stream({ output: ["a"] }), two)).toThrow(/UNPARSEABLE/);
  });

  it("fails closed on a frame without a verdict, an unknown frame and a repeated frame", () => {
    const missing = goodOutput();
    missing.frames.pop();
    expect(() => readJudgeStream(stream({ output: missing }), two)).toThrow(
      /MISSING_VERDICT.*L9\/b/,
    );
    const unknown = goodOutput();
    unknown.frames.push({ ...unknown.frames[0], id: "L9/zzz" } as never);
    expect(() => readJudgeStream(stream({ output: unknown }), two)).toThrow(
      /UNKNOWN_FRAME.*L9\/zzz/,
    );
    const repeated = goodOutput();
    repeated.frames.push(repeated.frames[0] as never);
    expect(() => readJudgeStream(stream({ output: repeated }), two)).toThrow(
      /REPEATED_FRAME.*L9\/a/,
    );
  });

  it("fails closed on an answer outside the two scales, or without reasons", () => {
    for (const edit of [
      (o: ReturnType<typeof goodOutput>) =>
        Object.assign(o.frames[0] as object, { verdict: "BETTER" }),
      (o: ReturnType<typeof goodOutput>) =>
        Object.assign(o.frames[0] as object, { vsUnreal: "IMPROVEMENT" }),
      (o: ReturnType<typeof goodOutput>) => Object.assign(o.frames[0] as object, { reasons: "  " }),
      (o: ReturnType<typeof goodOutput>) => Object.assign(o.overall, { verdict: "MATCH" }),
      (o: ReturnType<typeof goodOutput>) => Object.assign(o.overall, { reasons: "" }),
      (o: ReturnType<typeof goodOutput>) => Reflect.deleteProperty(o, "overall"),
    ]) {
      const output = goodOutput();
      edit(output);
      expect(() => readJudgeStream(stream({ output }), two)).toThrow(/BAD_VERDICT/);
    }
  });

  it("names the two scales", () => {
    expect([...VERDICTS, ...CLOSENESS]).toEqual([
      "IMPROVEMENT",
      "NEUTRAL",
      "REGRESSION",
      "MATCH",
      "CLOSE",
      "FAR",
    ]);
  });

  it("fails closed when the judge lists an image it could not read", () => {
    const output = { ...goodOutput(), unreadable: ["/w/u/L9/b.png"] };
    expect(() => readJudgeStream(stream({ output }), two)).toThrow(/UNREADABLE.*L9\/b/);
  });

  it("fails closed when the judge never opened an image, or the Read failed", () => {
    const skipped = stream({ reads: everyImage.slice(1) });
    expect(() => readJudgeStream(skipped, two)).toThrow(/UNREAD.*b1\/L9\/a\.png/);
    const failed = stream({ failed: [everyImage[3] as string] });
    expect(() => readJudgeStream(failed, two)).toThrow(/UNREAD/);
  });
});

describe("blockedBy", () => {
  const run = (frames: string[], overall: string) =>
    readJudgeStream(
      stream({
        output: {
          ...goodOutput(),
          frames: [
            { id: "L9/a", verdict: frames[0], vsUnreal: "CLOSE", reasons: "r", differences: "" },
            { id: "L9/b", verdict: frames[1], vsUnreal: "CLOSE", reasons: "r", differences: "" },
          ],
          overall: { verdict: overall, vsUnreal: "CLOSE", reasons: "r" },
        },
      }),
      two,
    );

  it("blocks on a REGRESSION in any frame or overall", () => {
    expect(blockedBy(run(["IMPROVEMENT", "NEUTRAL"], "IMPROVEMENT"), "preserve")).toEqual([]);
    expect(blockedBy(run(["IMPROVEMENT", "REGRESSION"], "IMPROVEMENT"), "preserve")).toEqual([
      "frame L9/b is a REGRESSION",
    ]);
    expect(blockedBy(run(["NEUTRAL", "NEUTRAL"], "REGRESSION"), "preserve")).toEqual([
      "the overall verdict is a REGRESSION",
    ]);
  });

  it("asks for IMPROVEMENT overall when the change promised one", () => {
    expect(blockedBy(run(["IMPROVEMENT", "NEUTRAL"], "NEUTRAL"), "improvement")).toEqual([
      "improvement was promised and the overall verdict is NEUTRAL",
    ]);
    expect(blockedBy(run(["IMPROVEMENT", "NEUTRAL"], "IMPROVEMENT"), "improvement")).toEqual([]);
  });
});

describe("buildPrompt", () => {
  it("carries the criteria, the layer and every image path, and says what the judge may do", () => {
    const prompt = buildPrompt("C1 Grain: none at 100%.", two);
    expect(prompt).toContain("C1 Grain: none at 100%.");
    for (const file of everyImage) expect(prompt).toContain(file);
    expect(prompt).toContain("L9/a (layer L9)");
    expect(prompt).toContain("UNREAL (L9-Epic): /w/u/L9/a.png");
    expect(prompt).toMatch(/Read tool and nothing else/);
    expect(prompt).toMatch(/IMPROVEMENT, NEUTRAL or REGRESSION/);
    expect(prompt).toMatch(/MATCH, CLOSE or FAR/);
  });
});

describe("claudeArgs", () => {
  const args = claudeArgs({ model: "sonnet", effort: "high", maxBudgetUsd: 5, dirs: ["/a", "/b"] });
  const argAfter = (flag: string) => args[args.indexOf(flag) + 1];

  it("starts a read-only Sonnet session with no customizations and no saved transcript", () => {
    expect(args).toContain("-p");
    expect(args).toContain("--safe-mode");
    expect(argAfter("--tools")).toBe("Read");
    expect(argAfter("--allowedTools")).toBe("Read");
    expect(argAfter("--permission-mode")).toBe("dontAsk");
    expect(argAfter("--model")).toBe("sonnet");
    expect(argAfter("--effort")).toBe("high");
    expect(args).toContain("--no-session-persistence");
    expect(argAfter("--output-format")).toBe("stream-json");
    expect(args.filter((a, i) => a === "--add-dir" && args[i + 1]?.startsWith("/"))).toHaveLength(
      2,
    );
    expect(args.join(" ")).not.toMatch(/Bash|Edit|Write|bypass/);
  });
});

describe("main", () => {
  const criteria = (root: string) => {
    const file = path.join(root, "criteria.md");
    writeFileSync(file, "C1 Grain: none at 100%.\n");
    return file;
  };
  const argv = (f: ReturnType<typeof filled>, extra: string[] = []) => [
    "--criteria",
    criteria(f.root),
    "--before",
    path.join(f.root, "before1"),
    "--before",
    path.join(f.root, "before2"),
    "--after",
    path.join(f.root, "after1"),
    "--after",
    path.join(f.root, "after2"),
    "--unreal",
    path.join(f.root, "unreal"),
    "--out",
    path.join(f.root, "out/verdict.json"),
    ...extra,
  ];
  const silence = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

  it("writes the verdict file, prints it and returns 0", async () => {
    const f = filled(["L9/a.png"]);
    const log = silence();
    const frames = collectFrames(f.sets());
    const images = frames.flatMap((x) => [...x.before, ...x.after, x.unreal]);
    const output = { ...goodOutput(), frames: [goodOutput().frames[0]] };
    const run = vi.fn(async (_: { prompt: string; args: string[] }) =>
      stream({ reads: images, output }),
    );
    expect(await main(argv(f), run)).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].prompt).toContain("C1 Grain: none at 100%.");
    const file = JSON.parse(readFileSync(path.join(f.root, "out/verdict.json"), "utf8"));
    expect(file).toMatchObject({
      status: "COMPLETE",
      model: "claude-sonnet-5-5",
      runs: { before: 2, after: 2 },
      overall: { verdict: "IMPROVEMENT" },
      blockedBy: [],
    });
    expect(file.frames[0]).toMatchObject({
      id: "L9/a",
      layer: "L9",
      unreal: "L9",
      verdict: "IMPROVEMENT",
    });
    expect(log.mock.calls.flat().join("\n")).toMatch(/L9\/a.*IMPROVEMENT.*CLOSE/s);
  });

  it("returns 2 and keeps the verdict when a frame regressed", async () => {
    const f = filled(["L9/a.png"]);
    silence();
    const images = collectFrames(f.sets()).flatMap((x) => [...x.before, ...x.after, x.unreal]);
    const frames = [{ ...goodOutput().frames[0], verdict: "REGRESSION" }];
    const run = async () => stream({ reads: images, output: { ...goodOutput(), frames } });
    expect(await main(argv(f), run)).toBe(2);
    const file = JSON.parse(readFileSync(path.join(f.root, "out/verdict.json"), "utf8"));
    expect(file.status).toBe("COMPLETE");
    expect(file.blockedBy).toEqual(["frame L9/a is a REGRESSION"]);
  });

  it("fails closed and records the failure in the verdict file", async () => {
    const f = filled(["L9/a.png"]);
    silence();
    const run = async () =>
      stream({ reads: [], output: undefined, result: { result: "looks fine" } });
    await expect(main(argv(f), run)).rejects.toThrow(/UNPARSEABLE/);
    const file = JSON.parse(readFileSync(path.join(f.root, "out/verdict.json"), "utf8"));
    expect(file.status).toBe("FAILED");
    expect(file.error).toMatch(/UNPARSEABLE/);
  });

  it("refuses mismatched layers before it starts a session", async () => {
    const f = filled(["L6/a.png"], ["L9/a.png"]);
    const run = vi.fn(async () => stream());
    await expect(main(argv(f), run)).rejects.toThrow(/LAYER_MISMATCH/);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(f.root, "out/verdict.json"), "utf8")).status).toBe(
      "FAILED",
    );
  });

  it("checks everything and starts no session on --dry-run", async () => {
    const f = filled(["L9/a.png"]);
    const log = silence();
    const run = vi.fn(async () => stream());
    expect(await main(argv(f, ["--dry-run"]), run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.root, "out/verdict.json"))).toBe(false);
    expect(log.mock.calls.flat().join("\n")).toMatch(/L9\/a/);
  });

  it("prints the usage and the layout rules on --help", async () => {
    const log = silence();
    const run = vi.fn(async () => stream());
    expect(await main(["--help"], run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toMatch(/unreal-look:judge.*names exactly one layer/s);
  });

  it("refuses a missing flag, an unknown flag and an empty criteria file", async () => {
    const f = filled(["L9/a.png"]);
    const run = vi.fn(async () => stream());
    const args = argv(f);
    await expect(main(args.slice(2), run)).rejects.toThrow(/BAD_INPUT.*--criteria/);
    await expect(main([...args, "--frobnicate"], run)).rejects.toThrow(/BAD_INPUT/);
    writeFileSync(path.join(f.root, "criteria.md"), "  \n");
    await expect(main(args, run)).rejects.toThrow(/BAD_INPUT.*criteria/);
    expect(run).not.toHaveBeenCalled();
  });
});
