# Final Cost

Actual engine GPU timestamp windows 3–5: dark 11.0467→11.7467 ms (+0.700 ms, 6.34%); backlit 11.6033→11.2267 ms is noise, not a speedup claim. Only 23 asynchronous timestamp samples per arm across three 60-frame windows in one serial run. Raw windows, provenance and full frames retained. No compile-complete or display-FPS claim.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
