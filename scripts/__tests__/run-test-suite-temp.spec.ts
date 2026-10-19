import { spawnSync } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
const scriptPath = path.resolve("scripts/run-test-suite.sh");

describe("run-test-suite temporary ownership", () => {
  it("uses the requested temporary parent and cleans only its own suite directory", async () => {
    const source = await readFile(scriptPath, "utf8");
    const start = source.indexOf('suite_tmp_root="$(mktemp');
    const end = source.indexOf("\nset +e", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const parent = await makeTempDir("tn suite parent ");
    const retained = path.join(parent, "retained-owner-evidence");
    await writeFile(retained, "preserve");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "heartbeat_pid=0; lease_registered=0; run_status=0",
            source.slice(start, end),
            'printf "%s\\n" "$suite_tmp_root" "$TMPDIR"',
          ].join("\n"),
        ],
        { encoding: "utf8", env: { ...process.env, TMPDIR: parent } },
      );
      expect(result.status, result.stderr).toBe(0);
      const [directory, inherited] = result.stdout.trim().split("\n");
      if (directory === undefined || inherited === undefined)
        throw new Error(`run-test-suite printed ${JSON.stringify(result.stdout)}`);
      expect(path.dirname(directory)).toBe(parent);
      expect(inherited).toBe(directory);
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(retained, "utf8")).toBe("preserve");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses allocation failures before continuing and removes only an owned empty directory", async () => {
    const source = await readFile(scriptPath, "utf8");
    const start = source.indexOf('suite_tmp_root="$(mktemp');
    const end = source.indexOf("\nset +e", start);
    const parent = await makeTempDir("tn allocation parent ");
    const receipt = path.join(parent, "receipt");
    const retained = path.join(parent, "retained");
    await writeFile(retained, "preserve");
    const snippet = source.slice(start, end);
    try {
      const directoryFailure = spawnSync(
        "bash",
        [
          "-c",
          [
            "heartbeat_pid=0; lease_registered=0; run_status=0",
            'mktemp() { printf "attempt\\n" >> "$TN_ALLOCATION_RECEIPT"; return 23; }',
            snippet,
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, TMPDIR: parent, TN_ALLOCATION_RECEIPT: receipt },
        },
      );
      expect(directoryFailure.status).toBe(23);
      expect(await readFile(receipt, "utf8")).toBe("attempt\n");
      const markerFailure = spawnSync(
        "bash",
        [
          "-c",
          [
            "heartbeat_pid=0; lease_registered=0; run_status=0",
            'mktemp() { if [[ "$1" == "-d" ]]; then local allocated; allocated="$(command mktemp "$@")" || return $?; printf "%s" "$allocated" > "$TN_ALLOCATION_RECEIPT"; printf "%s\\n" "$allocated"; else return 24; fi; }',
            snippet,
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, TMPDIR: parent, TN_ALLOCATION_RECEIPT: receipt },
        },
      );
      expect(markerFailure.status).toBe(24);
      await expect(stat(await readFile(receipt, "utf8"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(retained, "utf8")).toBe("preserve");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
