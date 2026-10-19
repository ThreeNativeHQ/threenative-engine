# Packed fixture canonical root

The normal root suite with a durable symlinked TMPDIR failed two packed MetaHuman consumer identity assertions: Node resolves import.meta URLs to the physical package path, while the fixture expected the symlink spelling. The fixture now resolves its extracted package root with realpath; all existing relative-WASM identity, checksum, lazy-loading and ordering assertions remain unchanged. No runtime package source changed.

Retained root failure: root-fullgate.log.gz. After correction, the actual packed consumer suite passed all 7 tests with the same TMPDIR (metahuman-canonical-root-green.log.gz). Independent review passed. The full root suite has not yet passed; its unit phase was not reached in this failed run.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
