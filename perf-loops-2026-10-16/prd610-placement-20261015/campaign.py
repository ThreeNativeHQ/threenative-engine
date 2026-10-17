#!/usr/bin/env python3
"""PRD-610 placement campaign: builds results.json and an offline index.html from raw screen logs.

Usage: campaign.py            regenerate both files (atomic replace)
       campaign.py --check    self-check: metric direction, missing values, unsafe text
Every number comes from the screens' run.log reports; decisions are the only hand-entered fields.
"""
import json, os, re, statistics, sys, tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCREENS = os.path.expanduser("~/.cache/tmp-tn/screens")
POSES = ["released-stick-climb", "canopy-and-instruments", "gun-view"]
POSE_NAMES = {"released-stick-climb": "takeoff", "canopy-and-instruments": "cockpit", "gun-view": "rear gunner"}

CAMPAIGN = {
    "id": "prd610-placement-20261015",
    "schema": 1,
    "started": "2026-10-15T15:57:53Z",
    "deadline": "2026-10-15T17:57:53Z",
    "owner": "Claude session b790b669, worktree .claude/worktrees/ne-epic, branch perf/prd610-resume",
    "startingRevision": "f92d01cc9",
    "dashboardCycle": "native-main-core-placement (http://127.0.0.1:8767/midway)",
}
CONTRACT = {
    "frozenAt": "2026-10-15T16:00:00Z",
    "primaryMetric": "Midway main-thread CPU ms per frame, exact 1,000-frame lockstep window (1 update + 1 render per frame), per pose; lower is better",
    "whyNotFrameP95": "Unavailable: the owned Xvfb lane throttles presents to about 47 ms per frame for both arms (physicalOutput=false); real-display lane blocked (PRD-610 AC-19). Active main-thread CPU is selected explicitly, as the skill allows for a capped lane.",
    "secondary": ["instructions per frame (must stay flat: placement changes no work)", "process-tree CPU ms per frame", "IPC"],
    "noiseRule": "margin = max(3%, 2 x max |baseline repeat - median| / median) per pose, from this campaign's baseline repeats; keep also needs >= 3x the two-run noise floor (performance-optimization-loop)",
    "keepRule": "median paired improvement above the margin at all three poses, same direction in all three alternating pairs, report pass=true in every run, instructions flat (+-1%), sentinel workload not regressed beyond its own margin",
    "gates": ["playtest report pass=true (Midway scenario assertions)", "ctest native_engine_player_thread_placement", "player free-run and frame-per-present ctests"],
    "series2": "Declared 2026-10-15T16:16Z, before any E3 candidate result: a run whose recorded host load1 exceeds 8 at start or end is invalid (both arms alike), excluded with that reason and rerun. Margin and keep rules unchanged. E2 stays judged under series 1.",
    "visualJudge": "Not required: thread affinity cannot change pixels (no render, material or timing change); instructions per frame are reported to show the work is identical.",
    "evaluator": {
        "screen": "screen-direct.sh sha256 67d881e1d61b504f (serialized by /tmp/claude-1000/tn-screen.lock)",
        "runner": "packages/playtest/dist/runner/cli.js sha256 83f3cd87b3620946",
        "scenario": "ac15-e3271a19c-b1-desktop/matched-cpu.playtest.json sha256 20e74e5111296f4b",
        "game": "player-rt/game.js sha256 e69f72523ba34517 (identical in every player dir)",
    },
    "environment": "AMD Ryzen 9 5900X (2 CCDs, SMT), NVIDIA RTX 2080 driver 615.78.08, Linux 7.2.9-2-cachyos, governor performance, private Xvfb 1280x720, FIFO present, V8 13.1.201.22, Release -O3. Host shared with other agent lanes: load recorded per run.",
    "binaries": {
        "player-rt": "2ce82ac2aabbeb19 (a57423817-era, no placement)",
        "player-place": "3c0bb7cf935c2300 (6878c53ff: placement, auto = top-ranked core)",
        "player-place2": "08cca3809ef53cbd (61c7c1d06: auto = last-ranked core)",
        "player-place3": "e7ef84f8dd9c00d5 (c4be636dc: L3-domain split, P-cores first)",
        "player-place4": "340e21f9de4d49c7 (e4c42d9c8: core pair, fastest cores first)",
    },
}
THREEJS = ["q-leg-1", "q-leg-2"]
EXPERIMENTS = [
    {
        "id": "E0-external-pinning",
        "kind": "diagnostic",
        "hypothesis": "The busy-waiting NVIDIA present on the GPU worker (55% of player cycles, 89% in vkQueuePresent / clock_gettime) and the HUD threads share the game thread's core, which holds its IPC at 0.57-0.70.",
        "change": "None in code: an external watcher pins the main TID to CPU 11 and every other player thread and child off CPU 11 and its sibling 23.",
        "baseline": ["q-rt0-1"], "candidate": ["q-iso-rt0-1", "q-iso-rt0-2"],
        "decision": "provisional", "reason": "Diagnostic only, not a shippable candidate. Both runs beat the unplaced run at every pose with identical instructions; it sized the lever.",
    },
    {
        "id": "E1-top-ranked-core",
        "kind": "candidate",
        "hypothesis": "The player can place itself: game thread on the CPPC top-ranked core pair, helpers swept off it once a second.",
        "change": "engine: packages/runtime-native/src/engine/player/run.cpp ThreadPlacement (commit 6878c53ff)",
        "baseline": ["q-place-off-1"],
        "candidate": ["q-place-auto-1"],
        "decision": "reject", "reason": "Preferred-core scheduling packs other busy work onto the top-ranked cores: a foreign Chrome renderer ran on CPU 3 at 82% during q-place-auto-1 (load 12-16), and the pinned game thread cannot leave. Worst row recorded; remaining E1 runs cancelled.",
    },
    {
        "id": "E2-last-ranked-core",
        "kind": "candidate",
        "hypothesis": "The same placement on the CPPC last-ranked core pair, which the scheduler fills last.",
        "change": "engine: run.cpp auto pick inverted (commit 61c7c1d06)",
        "baseline": ["q-place-off-1", "q-place-off-2", "q-place-off-3"],
        "candidate": ["q-last-auto-1", "q-last-auto-2", "q-last-auto-3"],
        "decision": "inconclusive", "reason": "Series 1: -21/-33/-32% median, 8 of 9 pose-pairs faster, but one baseline at load 10.7 set margins of 130/105/35%. Rerun as E2s2.",
    },
    {
        "id": "E3-l3-domain-split",
        "kind": "candidate", "series": 2,
        "hypothesis": "Game thread on the last-ranked core's L3 domain (CCD), helpers on the other domain: no shared core or L3 with the present spin, and the game thread can still move between 12 CPUs when another process lands on one.",
        "change": "engine: run.cpp ThreadPlacement domain split, P-cores first (commit c4be636dc)",
        "baseline": ["q-l3-off-1", "q-l3-off-2"],
        "candidate": ["q-l3-auto-1r"],
        "decision": "reject", "reason": "Pairs in ABBA order on frozen player-place3 e7ef84f8dd9c00d5. q-l3-auto-1 (load 8.8 to 19.7) and q-l3-auto-2 (load 15 at start) excluded under series 2; the load came from other lanes. q-l3-auto-2r and q-l3-auto-2rb ended above load 8 (excluded). REJECT: the one valid pair moved in opposite directions per pose (takeoff 7.81 to 9.58 ms, +23%; cockpit -5%; rear gunner -16%), so the same-direction rule cannot hold; remaining pairs cancelled.",
    },
    {
        "id": "E2s2-last-ranked-core",
        "kind": "candidate", "series": 2,
        "hypothesis": "E2 rerun under the series-2 load gate: E1 series showed -21/-33/-32% but its baseline spiked to load 10.7, which set the margin above the gain.",
        "change": "engine: run.cpp auto = last-ranked core pair (commit 61c7c1d06), frozen player-place2 08cca3809ef53cbd",
        "baseline": ["q-e2s2-off-1", "q-e2s2-off-2", "q-e2s2-off-3b"],
        "candidate": ["q-e2s2-auto-1b", "q-e2s2-auto-2"],
        "decision": "inconclusive", "reason": "2 valid pairs of 3 (q-e2s2-auto-3 and -3b ended at load 32.7 and 11.7). Both pairs faster at every pose, instructions identical, all pass, but baseline spread (9.13-10.25 ms takeoff) sets margins of 14/29/33% above the 29/19/4% median gains at cockpit and rear gunner. Placement ships opt-in.",
    },
    {
        "id": "E2s3-core-pair-final",
        "kind": "candidate", "series": 2,
        "hypothesis": "Core-pair policy (restored after the E3 reject) on a quieter host, frozen player-place4 340e21f9de4d49c7 built from e4c42d9c8.",
        "change": "engine: run.cpp auto = last-ranked core pair among the fastest cores (commit e4c42d9c8)",
        "baseline": ["q-e2s3-off-1", "q-e2s3-off-2", "q-e2s3-off-3"],
        "candidate": ["q-e2s3-auto-1", "q-e2s3-auto-2", "q-e2s3-auto-3"],
        "decision": "reject", "reason": "Final clean series, all six valid and passing, instructions identical. Cockpit -25/-24/-20% (median 20.1%, margin 20.3%); takeoff +3.7/-4.1/-17.8% and rear gunner -12.0/+8.0/-10.6% change direction. The default stays off; the code stays opt-in. R5 sentinel: 6 runs exit 0.",
    },
    {"id": "D1-gl-yield", "kind": "diagnostic", "hypothesis": "__GL_YIELD=USLEEP makes the NVIDIA present wait sleep instead of spin.",
     "change": "None in code (environment variable).", "baseline": ["q-rt0-1"], "candidate": ["q-yield-rt0-1"],
     "decision": "reject", "reason": "IPC stayed 0.58-0.61 and CPU did not fall; second run cancelled."},
    {"id": "D2-core-pair-watcher", "kind": "diagnostic", "hypothesis": "Main on its whole core pair (11,23), helpers off it.",
     "change": "None in code (external watcher).", "baseline": ["q-rt0-1"], "candidate": ["q-v1core-rt0-1"],
     "decision": "inconclusive", "reason": "One run while host load rose from 5.2 to 11.8."},
    {"id": "D3-ccd-split-watcher", "kind": "diagnostic", "hypothesis": "Main on one CCD (6-11,18-23), helpers on the other (0-5,12-17).",
     "change": "None in code (external watcher).", "baseline": ["q-rt0-1"], "candidate": ["q-v3ccd-rt0-1"],
     "decision": "provisional", "reason": "One run at load 12-16 kept IPC 0.70-0.77, better than the unplaced run at load 3: the most load-robust shape seen. Basis for E3."},
]
NEXT = "Placement closed: opt-in only. The remaining native gap is work per frame (render prepare/encode 39%, AnimationMixer 12%, JS-to-C++ calls 28%): PRD-610 AC-16 to AC-19."


def screen(name):
    """One screen's per-pose numbers, or a reason it is unavailable."""
    d = os.path.join(SCREENS, name)
    try:
        text = open(os.path.join(d, "run.log")).read()
        report = json.loads(text[text.rfind("\n{") + 1:])
        windows = {w["label"]: w for w in report["acquisition"]["cpuWindows"]}
    except FileNotFoundError:
        return {"name": name, "unavailable": "not run yet"}
    except Exception as error:  # incomplete or malformed log
        return {"name": name, "unavailable": f"no complete report ({error.__class__.__name__})"}
    loads = re.findall(r"load average: ([0-9.]+)", open(os.path.join(d, "host-load.txt")).read())
    placement = re.search(r"TN_THREAD_PLACEMENT main=([0-9,]+)", text)
    poses = {}
    for pose in POSES:
        w = windows.get(pose)
        if not w or w["frames"] != 1000 or w["updates"] != 1000 or w["renders"] != 1000:
            poses[pose] = None
            continue
        m = w["mainThread"]
        poses[pose] = {"cpuMs": m["cpuMsPerFrame"], "instrM": m["instructionsPerFrame"] / 1e6,
                       "ipc": m["instructions"] / m["cycles"], "treeMs": w["processTree"]["cpuMs"] / w["frames"]}
    return {"name": name, "pass": report.get("pass") is True, "load": loads,
            "placement": placement.group(1) if placement else None, "poses": poses}


def improvement(base, cand):
    """Lower is better: percent saved against a positive baseline, else None."""
    if base is None or cand is None or base <= 0:
        return None
    return 100 * (base - cand) / base


MAX_LOAD = 8.0  # series 2 admission


def valid(exp, s):
    """Series-2 experiments exclude a run whose start or end load1 exceeds MAX_LOAD."""
    if not s.get("poses"):
        return False
    return not (exp.get("series") == 2 and any(float(x) > MAX_LOAD for x in s.get("load", [])))


def summarize(exp, screens):
    out = {}
    exp = {**exp, "baseline": [n for n in exp["baseline"] if valid(exp, screens[n])],
           "candidate": [n for n in exp["candidate"] if valid(exp, screens[n])]}
    for pose in POSES:
        base = [screens[n]["poses"][pose]["cpuMs"] for n in exp["baseline"] if screens[n].get("poses", {}).get(pose)]
        cand = [screens[n]["poses"][pose]["cpuMs"] for n in exp["candidate"] if screens[n].get("poses", {}).get(pose)]
        row = {"baseline": base, "candidate": cand}
        if base:
            med = statistics.median(base)
            row["baselineMedian"] = med
            row["marginPct"] = max(3.0, 200 * max(abs(x - med) for x in base) / med) if len(base) > 1 else None
        if base and cand:
            row["candidateMedian"] = statistics.median(cand)
            row["improvementPct"] = improvement(row["baselineMedian"], row["candidateMedian"])
            pairs = list(zip(exp["baseline"], exp["candidate"]))
            row["pairs"] = [improvement(screens[a]["poses"][pose]["cpuMs"], screens[b]["poses"][pose]["cpuMs"])
                            if screens[a].get("poses", {}).get(pose) and screens[b].get("poses", {}).get(pose) else None
                            for a, b in pairs]
        out[pose] = row
    return out


def build():
    names = sorted({n for e in EXPERIMENTS for n in e["baseline"] + e["candidate"]} | set(THREEJS))
    screens = {n: screen(n) for n in names}
    experiments = [{**e, "summary": summarize(e, screens)} for e in EXPERIMENTS]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"campaign": {**CAMPAIGN, "updated": now, "heartbeat": now, "status": "closed", "next": NEXT},
            "contract": CONTRACT, "threejs": THREEJS, "screens": screens, "experiments": experiments}


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRD-610 placement campaign</title><style>
:root{--bg:#fff;--fg:#1b1b1b;--mut:#666;--line:#ddd;--good:#0a7a30;--bad:#b3261e;--pend:#7a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#9a9a9a;--line:#333;--good:#5fd38a;--bad:#ff8a80;--pend:#e0c060}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:right}
th:first-child,td:first-child{text-align:left}.wrap{overflow-x:auto}.mut{color:var(--mut)}
.keep{color:var(--good)}.reject{color:var(--bad)}.pending,.provisional,.inconclusive,.invalid{color:var(--pend)}
details{border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:8px 0}summary{cursor:pointer;font-weight:600}
</style></head><body>
<h1>PRD-610: game-thread placement campaign</h1>
<p id="snap" class="mut"></p>
<h2>Now</h2><div id="now"></div>
<h2>Benchmarks: main-thread CPU ms per frame (lower is better)</h2><div class="wrap" id="bench"></div>
<h2>Experiments</h2><label>Decision filter <select id="filter"><option value="">all</option></select></label><div id="exps"></div>
<h2>Runs</h2><div class="wrap" id="runs"></div>
<h2>Coverage and continuation</h2><div id="cov"></div>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const P = ["released-stick-climb","canopy-and-instruments","gun-view"], N = {"released-stick-climb":"takeoff","canopy-and-instruments":"cockpit","gun-view":"rear gunner"};
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const f = (v, d = 2) => v === null || v === undefined ? "unavailable" : Number(v).toFixed(d);
const pct = (v) => v === null || v === undefined ? "unavailable" : (v >= 0 ? "-" : "+") + Math.abs(v).toFixed(1) + "%";
document.getElementById("snap").textContent = `Snapshot ${D.campaign.updated} (static file: reload for current progress).`;
const now = document.getElementById("now"); const c = D.campaign;
for (const [k, v] of [["Status", c.status], ["Started", c.started], ["Deadline", c.deadline], ["Owner", c.owner], ["Dashboard cycle", c.dashboardCycle], ["Evidence", "gameplay (Midway, Xvfb, fixed-step windows); no synthetic result yet"], ["Next", c.next]]) { const p = el("p"); p.append(el("strong", k + ": "), el("span", v)); now.append(p); }
const tbl = (head, rows) => { const t = el("table"); const h = el("tr"); head.forEach(x => h.append(el("th", x))); t.append(h); rows.forEach(r => { const tr = el("tr"); r.forEach(x => tr.append(x instanceof Node ? x : el("td", x))); t.append(tr); }); return t; };
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const tj = P.map(p => med(D.threejs.map(n => D.screens[n]?.poses?.[p]?.cpuMs).filter(x => x !== undefined && x !== null)));
const rows = [];
for (const e of D.experiments) for (const [i, p] of P.entries()) { const s = e.summary[p]; const td = el("td", e.decision, e.decision);
  rows.push([e.id, N[p], f(s.baselineMedian), f(s.candidateMedian), pct(s.improvementPct), s.marginPct ? s.marginPct.toFixed(1) + "%" : "unavailable", `${s.baseline.length}/${s.candidate.length}`, tj[i] && s.candidateMedian ? (tj[i] / s.candidateMedian).toFixed(2) + "x" : "unavailable", td]); }
document.getElementById("bench").append(tbl(["Experiment", "Pose", "Baseline median", "Candidate median", "Change", "Noise margin", "Runs b/c", "three.js / candidate", "Decision"], rows));
const tjp = el("p", `three.js reference (Chromium renderer main thread, same window): ${P.map((p, i) => N[p] + " " + f(tj[i])).join(", ")} ms from ${D.threejs.join(", ")}. Goal: 2x (owner bar), stretch 3x.`, "mut"); document.getElementById("bench").append(tjp);
const sel = document.getElementById("filter"); [...new Set(D.experiments.map(e => e.decision))].forEach(d => sel.append(el("option", d)));
const exps = document.getElementById("exps");
const draw = () => { exps.replaceChildren(); for (const e of D.experiments) { if (sel.value && e.decision !== sel.value) continue; const d = el("details"); const s = el("summary"); s.append(el("span", e.id + " "), el("span", "[" + e.decision + "]", e.decision)); d.append(s);
  for (const [k, v] of [["Kind", e.kind], ["Hypothesis", e.hypothesis], ["Change", e.change], ["Decision reason", e.reason], ["Baseline runs", e.baseline.join(", ")], ["Candidate runs", e.candidate.join(", ")]]) { const p = el("p"); p.append(el("strong", k + ": "), el("span", v)); d.append(p); }
  d.append(tbl(["Pose", "Paired changes (baseline-first order)"], P.map(p => [N[p], (e.summary[p].pairs || []).map(pct).join(", ") || "unavailable"]))); exps.append(d); } };
sel.addEventListener("change", draw); draw();
document.getElementById("runs").append(tbl(["Run", "Pass", "Load start/end", "Placement", ...P.map(p => N[p] + " ms / M instr / IPC")], Object.values(D.screens).map(s => [s.name, s.unavailable ? s.unavailable : String(s.pass), (s.load || []).join(" / "), s.placement || "none", ...P.map(p => { const v = s.poses?.[p]; return v ? `${f(v.cpuMs)} / ${f(v.instrM, 1)} / ${f(v.ipc)}` : "unavailable"; })])));
const cov = document.getElementById("cov"); for (const t of ["Platforms: Linux desktop (Xvfb, NVIDIA) measured. Real display: blocked (AC-19). Windows, macOS: placement code not compiled there; unmeasured. Android: excluded by #if.", "Sentinel: not run. Its first attempt failed on resolution (fixed), then it was stopped because no candidate passed.", "Frame p95: " + D.contract.whyNotFrameP95, "Contract: " + D.contract.keepRule, "Noise rule: " + D.contract.noiseRule, "Resume: python3 campaign.py regenerates this page from ~/.cache/tmp-tn/screens; next hypothesis above."]) cov.append(el("p", t));
</script></body></html>"""


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w") as out:
        out.write(text)
    os.replace(tmp, path)


def render(data):
    return PAGE.replace("__DATA__", json.dumps(data).replace("<", "\\u003c"))


def check():
    assert improvement(10.0, 8.0) == 20.0 and improvement(10.0, 12.0) == -20.0, "lower is better"
    assert improvement(0, 1) is None and improvement(None, 1) is None, "missing or zero baseline is unavailable"
    page = render({"x": "</script><script>alert(1)</script>"})
    assert "</script><script>alert" not in page, "embedded text cannot close the data script"
    assert screen("does-not-exist")["unavailable"] == "not run yet", "missing run is unavailable, not zero"
    print("PASS campaign.py self-check")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
        sys.exit(0)
    data = build()
    write_atomic(os.path.join(HERE, "results.json"), json.dumps(data, indent=1) + "\n")
    write_atomic(os.path.join(HERE, "index.html"), render(data))
    print("wrote results.json and index.html", data["campaign"]["updated"])
