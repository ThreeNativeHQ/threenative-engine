#!/usr/bin/env python3
"""usage: dash.py <exp-id> <tsv-tag> <decision|None> <hypothesis> <candidate> <gameResult> <reason>
Upserts one experiment on the Tempest dashboard from a runs/<tag>.tsv and re-renders."""
import json, re, subprocess, sys

D = "/home/joao/projects/threenative/threenative-engine/artifacts/native-performance-loop/tempest-20261016"
eid, tag, decision, hyp, cand, game, reason = sys.argv[1:8]
decision = None if decision == "None" else decision
rows = []
for l in open(f"/tmp/prd617perf/runs/{tag}.tsv"):
    p = l.rstrip().split("\t")
    if len(p) < 6 or "ERR" in l:
        continue
    tot = re.search(r"total=([\d.]+)", l).group(1)
    big = re.findall(r"'(scene\d+x\d+)#\d+': ([\d.]+)", l)
    rows.append((p[0], float(tot), big))
pairs = "; ".join(f"{a}: total {t:.1f} ms ({', '.join(f'{n} {float(v):.1f}' for n, v in big if float(v) > 3)})" for a, t, big in rows)
r = json.load(open(f"{D}/results.json"))
e = {
    "id": eid, "hypothesis": hyp,
    "bottleneckEvidence": "the world march is 36 of 44 ms and is smooth, so it can render below frame resolution",
    "layer": "game (template src/render, owner-approved)", "files": ["packages/create-threenative/templates/rain/src/render/world.ts", "packages/create-threenative/templates/rain/src/render/quality.ts"],
    "candidate": cand, "unit": "ms", "scalar": None,
    "prediction": "march cost falls with pixel count: frame GPU at or under 22 ms",
    "falsifier": "frame GPU over 22 ms, or a visible regression at the judged poses",
    "pairs": pairs, "gameResult": game, "sentinelResult": "not applicable", "gates": "judge pending",
    "tradeoffs": "lower march resolution, upscaled depth-aware", "decision": decision, "reason": reason,
    "duration": "short", "workload": "Tempest", "platform": "web", "evidence": [],
}
r["experiments"] = [x for x in r["experiments"] if x["id"] != eid] + [e]
json.dump(r, open(f"{D}/results.json", "w"), indent=2)
subprocess.run(["node", "check-render.mjs"], cwd=D, check=True, capture_output=True)
subprocess.run(["node", "render.mjs"], cwd=D, check=True, capture_output=True)
print("ok", pairs)
