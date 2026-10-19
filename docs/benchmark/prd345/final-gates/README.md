# Final gate logs

Root typecheck and lint pass. Affected CPU verification passes 65 files / 1011 tests. The isolated native host and V8/QuickJS prerequisites build; actual native unit tests pass 1531, with 62 skipped. Native unit/build results do not qualify native appearance.

The retained full-root attempt completed docs/build then failed on 21 absent native test binaries. Its raw failure remains retained; prerequisites were built afterward. Full root verification, all-thirteen generated gameplay and matched native fallback remain pending. No skipped lane is reported as passing.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
