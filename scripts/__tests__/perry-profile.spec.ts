import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCallers,
  formatDiff,
  formatTop,
  loadProfile,
  normalizeSymbol,
  parsePerfScript,
  parseProfileArgs,
  selectWindow,
  tsFrame,
} from "../perry-profile.js";

const module = "node_modules_three_engine_src_perry_transport_ts";
const caller = `${module}__readNumbers`;
const samples = [
  { time: 10, frames: ["__vdso_clock_gettime", "clock_gettime", "js_now", caller] },
  { time: 10.5, frames: ["js_array_get_f64", caller, caller] },
  { time: 11, frames: ["js_array_get_f64", `perry_closure_${module}__42`, caller] },
  { time: 12, frames: ["__vdso_clock_gettime", "clock_gettime", "native_main"] },
];

describe("Perry source attribution", () => {
  it("uses only positively identified TS frames, normalizing closures and Rust symbols", () => {
    expect(tsFrame(`perry_fn_${caller}`)).toEqual({ function: caller, module });
    expect(tsFrame(`perry_method_${caller}`)).toEqual({ function: caller, module });
    expect(tsFrame(`perry_closure_${module}__42`)).toEqual({
      function: `${module} (closure)`,
      module,
    });
    for (const symbol of [
      "js_array_get_f64",
      "perry_runtime::foo",
      "__vdso_clock_gettime",
      "mi_free",
      "mi_heap_ts__alloc",
      "std::helper_ts__call",
      "__vdso_helper_ts__call",
      "memcpy",
      "0x123",
      "native_main",
      "js_fake_ts__foo",
    ])
      expect(tsFrame(symbol)).toBeUndefined();
    expect(
      normalizeSymbol(
        "_ZN13perry_runtime6buffer6header25is_registered_buffer_slow17h0123456789abcdefE",
      ),
    ).toBe("perry_runtime::buffer::header::is_registered_buffer_slow");
  });
  it("attributes to the nearest TS ancestor and retains its immediate callee, including unknown ancestry", () => {
    const text = formatCallers(samples, ["__vdso_clock_gettime", "js_array_get_f64"]);
    expect(text).toContain(`25.00%\t50.00%\t1\t${caller}\t<- js_now`);
    expect(text).toContain("[no TS frame]");
    expect(text).toContain(`${module} (closure)`);
    expect(formatCallers(samples, ["no_such_leaf"])).toContain("0/4 samples");
    expect(
      formatCallers(
        [
          { time: 1, frames: ["leaf", "runtimeA", caller] },
          { time: 2, frames: ["leaf", "runtimeB", caller] },
          { time: 3, frames: ["leaf", "runtimeA", caller] },
        ],
        ["leaf"],
      ),
    ).toContain(`100.00%\t100.00%\t3\t${caller}\t<- runtimeA (dominant 2/3)`);
  });
  it("deduplicates recursive TS functions and modules within inclusive samples", () => {
    const text = formatTop(samples);
    expect(text).toContain(`75.00%\t3\t${caller}`);
    expect(text).toContain(`75.00%\t3\t${module}`);
    expect(text).toContain("50.00%\t2\tjs_array_get_f64");
    const diff = formatDiff(samples, samples.slice(2));
    expect(diff).toContain(`75.00%\t50.00%\t-25.00pp\t${caller}`);
  });
  it("splits at the first frame, honors an explicit split, and refuses an unknown boundary", () => {
    // firstFrameMs is frame duration, not time from launch; it must not become the split.
    const log =
      'TN_PROFILE_CLOCK:{"perfTimeSec":9,"wallTimeMs":100000}\nTN_FRAME_HITCH:{"uptimeMs":0,"wallClock":102000}\nTN_PLAYER_TIMING:{"readyMs":1800,"firstFrameMs":900}';
    expect(selectWindow(samples, "startup", undefined, log).samples).toEqual(samples.slice(0, 2));
    expect(selectWindow(samples, "steady", undefined, log).samples).toEqual(samples.slice(2));
    expect(selectWindow(samples, "steady", 500).samples).toEqual(samples.slice(1));
    expect(selectWindow(samples, "all").samples).toEqual(samples);
    expect(() =>
      selectWindow(
        samples,
        "steady",
        undefined,
        'TN_PLAYER_TIMING:{"readyMs":1800,"firstFrameMs":900}',
      ),
    ).toThrow("--split-ms");
    expect(() => selectWindow(samples, "steady", 99999)).toThrow("No samples");
  });
  it("reads real leaf-first perf callchains and rejects missing or malformed samples", async () => {
    const fixture = await readFile(
      new URL("./fixtures/perry-profile/perf-script.txt", import.meta.url),
      "utf8",
    );
    const parsed = parsePerfScript(fixture);
    expect(parsed).toHaveLength(50);
    expect(parsed.some((sample) => sample.frames.some((frame) => tsFrame(frame)))).toBe(true);
    expect(
      parsePerfScript(
        "1.000000:\n  abc js_array_get_f64+0x12 (/tmp/game)\n  def perry_fn_src_game_ts__tick (/tmp/game)\n",
      )[0]?.frames,
    ).toEqual(["js_array_get_f64", "src_game_ts__tick"]);
    expect(() => parsePerfScript("# no samples")).toThrow();
    expect(() => parsePerfScript("1.000000:\n garbage\n")).toThrow();
    expect(parsePerfScript("1.000000:\n\n")[0]?.frames).toEqual(["[no callchain]"]);
  });
  it("validates every subcommand and window flag in either argument order", () => {
    expect(
      parseProfileArgs(["top", "--window", "steady", "a.data", "--split-ms", "500"]),
    ).toMatchObject({ command: "top", files: ["a.data"], window: "steady", splitMs: 500 });
    expect(parseProfileArgs(["callers", "a.data", "clock", "array"]).patterns).toEqual([
      "clock",
      "array",
    ]);
    for (const args of [
      ["top"],
      ["diff", "a"],
      ["callers", "a"],
      ["top", "a", "--window", "bad"],
      ["top", "a", "--split-ms", "NaN"],
      ["callers", "a", "["],
      ["top", "a", "--bad"],
    ])
      expect(() => parseProfileArgs(args)).toThrow();
  });
  it("caches timestamped folded stacks, invalidates changed data, and runs one nice reader", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "perry-profile-"));
    const data = path.join(directory, "perf.data");
    let calls = 0;
    const readScript = async (args: string[]) => {
      calls++;
      expect(args.slice(0, 4)).toEqual(["-n", "19", "perf", "script"]);
      expect(args).toContain("--demangle");
      expect(args).toContain("--no-inline");
      return "1.000000:\n abc js_array_get_f64 (/tmp/game)\n def perry_fn_src_game_ts__tick (/tmp/game)\n";
    };
    try {
      await writeFile(data, "first");
      const first = await loadProfile(data, undefined, readScript);
      expect(await loadProfile(data, undefined, readScript)).toEqual(first);
      expect(calls).toBe(1);
      expect(await readFile(`${data}.folded`, "utf8")).toContain(
        "1\tsrc_game_ts__tick;js_array_get_f64 1",
      );
      await writeFile(data, "second-build");
      expect(await loadProfile(data, undefined, readScript)).toEqual(first);
      expect(calls).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
