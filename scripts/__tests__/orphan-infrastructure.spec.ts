import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";

it.each(["0", "1"])(
  "retains lease, queue and directory leak checks with CAPTURE_LOCK=%s",
  async (mode) => {
    const source = await readFile("packages/playtest/__tests__/orphan-cleanup.sh", "utf8");
    const start = source.indexOf('capture_coordination_root="$suite_temp_root/');
    const end = source.indexOf("\nbefore_temp_directories=", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const root = await makeTempDir("tn-orphan-infrastructure-");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            'set -euo pipefail; suite_temp_root="$TN_TEST_ROOT"',
            source.slice(start, end),
            "capture_coordination_empty",
            'test "$(find "$suite_temp_root" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1',
            'mkdir "$capture_coordination_root/lock"',
            'printf "owned lease\\n" > "$capture_coordination_root/lock/holder.json"',
            "if capture_coordination_empty; then exit 21; fi",
            'test -f "$capture_coordination_root/lock/holder.json"',
            'rm "$capture_coordination_root/lock/holder.json"; rmdir "$capture_coordination_root/lock"',
            'printf "owned waiter\\n" > "$capture_coordination_root/queue/123.json"',
            "if capture_coordination_empty; then exit 22; fi",
            'test -f "$capture_coordination_root/queue/123.json"',
            'rm "$capture_coordination_root/queue/123.json"; capture_coordination_empty',
            'mkdir "$suite_temp_root/foreign"; printf preserve > "$suite_temp_root/foreign/sentinel"',
            'ln -s "$suite_temp_root/foreign" "$capture_coordination_root/lock"',
            "if capture_coordination_empty; then exit 23; fi",
            'test "$(cat "$suite_temp_root/foreign/sentinel")" = preserve',
            'rm "$capture_coordination_root/lock"; capture_coordination_empty',
            'rmdir "$capture_coordination_root/queue"; ln -s "$suite_temp_root/foreign" "$capture_coordination_root/queue"',
            "if capture_coordination_empty; then exit 24; fi",
            'test "$(cat "$suite_temp_root/foreign/sentinel")" = preserve',
          ].join("\n"),
        ],
        { encoding: "utf8", env: { ...process.env, CAPTURE_LOCK: mode, TN_TEST_ROOT: root } },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
