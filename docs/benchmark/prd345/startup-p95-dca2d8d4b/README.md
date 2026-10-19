# Startup P95 Dca2D8D4B

Runtime checkpoint dca2d8d4b, unchanged generated source trees: 80/80 fresh Chromium launches pass, 40 per arm in ABBA order. Ready p95 2649.7→2831.0 ms (+181.3 ms, 6.84%); median 2560.3→2760.0 ms. All samples and frozen manifests retained. Fresh process/context/page and HTTP cache; OS/filesystem and driver shader caches uncontrolled. Not shader-cold, compile-complete or a precise population-tail estimate.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
