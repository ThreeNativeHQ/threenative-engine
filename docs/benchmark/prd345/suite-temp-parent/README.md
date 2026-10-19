# Durable suite temporary parent

The full verification script now honors explicit `TMPDIR` with the existing `/tmp` default.
Actual allocation/cleanup regression was RED when the script ignored the requested parent.
A second RED exposed continued execution after failed allocation under `set -u` without `-e`.
Directory allocation now fails closed; marker allocation failure removes only its own newly
created empty directory and preserves the failure status. No checks, phase ordering, filters,
permissions or successful cleanup behavior changed.

Three focused/CI partition specs pass 142 tests. Behavioral tests use a space-bearing parent,
verify exported temporary location and unrelated sentinel preservation, and cover directory
and marker failures. Shell syntax and formatting pass. Independent source review reports no
remaining finding. These are harness tests, not a completed full-root gate.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
