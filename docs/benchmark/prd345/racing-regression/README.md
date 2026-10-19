# Racing regression controls

The rejected material callback called `updateWorldMatrix(true, false)` on the shared key and target during renderer traversal. That changed the road and shadow image even at zero rim/fill gain. Sampling-only, bare upstream node-material copy and material-emissive-only controls preserved baseline pixels. The otherwise identical expression without those two writes restored baseline pixels. Final enabled racing frames now retain the original road/shadows with only the subtle car rim.

Rejected candidate PNGs and raw control reports are retained here. Final admitted boot images are in [the twelve-template matrix](../final-template-matrix/README.md). This causal boot comparison does not prove full gameplay or native appearance acceptance.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
