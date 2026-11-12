#!/bin/sh
# PRD-449 scoreboard: TN vs Godot on one cube scene. Rows: shipped defaults (TN L3 / Godot L1),
# explicit instancing (L2 / L2), can't batch (L4 / L4), at 1,024 and 4,096 cubes; 3 alternating
# runs per engine, 40 warmup + 120 measured, 1280x720 uncapped on the physical display.
#
# PRD-464's realistic-scene ladder follows on the same 4,096-cube scene: a shadowed sun, 8 moving
# point lights, 50 skinned Khronos foxes, tonemapping and bloom, and finally the whole thing at
# 1920x1080. Same protocol, 3 alternating runs per engine, and one window per resolution — R1-R4
# run in a 1280x720 window and R5 in a 1920x1080 one — so neither engine ever renders a buffer at a
# size its window then has to scale.
# Usage: pnpm bench:scoreboard [tag]   (tag defaults to today's date; outputs never overwrite)
set -u
tag=${1:-$(date +%F)}
export DISPLAY=${DISPLAY:-:0} TN_BENCH_DISPLAY=${TN_BENCH_DISPLAY:-${DISPLAY:-:0}}
# Every result JSON records the tree it was measured on, so a number can be traced to a commit.
sha=$(git rev-parse HEAD)
export GODOT_BIN=${GODOT_BIN:-$PWD/artifacts/engine-load-test/prd-449/godot-bin/Godot_v4.7.1-stable_linux.x86_64}
run() {
  pnpm -s bench:engines --arm "$1-desktop" --ladder 1024,4096 --modes "$2" --frames 160 --warmup 40 \
    --repeats 1 --skip-baseline --source-sha "$sha" --out "prd-449/pilots/scoreboard-$1-r$3-$tag" || exit 1
}
# One engine's whole ladder: R1-R4 at 720p, then R5 at 1080p, as two runs so each window is the
# resolution its rung draws at.
ladder() {
  pnpm -s bench:engines --arm "$1-desktop" --ladder 4096 --modes R1,R2,R3,R4 --frames 160 --warmup 40 \
    --repeats 1 --skip-baseline --source-sha "$sha" --out "prd-449/pilots/ladder-$1-r$2-$tag" || exit 1
  pnpm -s bench:engines --arm "$1-desktop" --ladder 4096 --modes R5 --width 1920 --height 1080 \
    --frames 160 --warmup 40 --repeats 1 --skip-baseline \
    --source-sha "$sha" --out "prd-449/pilots/ladder1080-$1-r$2-$tag" || exit 1
}
run tn L2,L3,L4 1; run godot L1,L2,L4 1
run godot L1,L2,L4 2; run tn L2,L3,L4 2
run tn L2,L3,L4 3; run godot L1,L2,L4 3
ladder tn 1; ladder godot 1
ladder godot 2; ladder tn 2
ladder tn 3; ladder godot 3
pnpm -s bench:engines:monitor
