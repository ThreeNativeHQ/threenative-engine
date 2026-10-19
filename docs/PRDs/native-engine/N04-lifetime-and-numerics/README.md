# N04 — Native object lifetime and numerical foundation

**Status:** PROPOSED — sliced 2026-10-04 into PRD-501 … PRD-504. This index carries no boxes; the child PRDs do.

N04 must show that the native public object graph keeps Three.js semantics where game code can observe them (§6, §7). The required evidence (§16) is tests for aliasing, cycle reclamation, resource lifetime, manual matrices and buffer lifetime. Each child has its own fixtures, so the lifetime design can stabilise before N05 and N06 build on it. One owner keeps the handle, callback and lifetime model coherent (§17).

| Key | PRD | Depends on |
| --- | --- | --- |
| N04a | [PRD-501 — Math matches the pinned reference](PRD-501-n04a-math-matches-the-pinned-reference.md) | [PRD-500](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md) |
| N04b | [PRD-502 — Handles keep identity and aliases](PRD-502-n04b-handles-keep-identity-and-aliases.md) | PRD-500 |
| N04c | [PRD-503 — Unreachable cycles are reclaimed](PRD-503-n04c-unreachable-cycles-are-reclaimed.md) | PRD-502 |
| N04d | [PRD-504 — Buffers cross the ABI with an owner](PRD-504-n04d-buffers-cross-the-abi-with-an-owner.md) | PRD-502 |

A minimal N04a + N04b fixture is enough to unblock the early compiler gate ([N05](../N05-native-typescript-qualification/README.md)). N04c must land before N05b's callback-rooting proof.

Back to the [batch index](../README.md).
