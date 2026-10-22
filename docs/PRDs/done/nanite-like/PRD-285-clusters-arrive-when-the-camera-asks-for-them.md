---
prd_contract: v1
---

# PRD-285 — clusters arrive when the camera asks for them

**Status: DEFERRED on its own precondition — 2026-08-30. Phase 5 of the
[virtual geometry batch](./README.md). This phase defers alone and the batch stays open.**

**Revisit when** a game in this repository or the sandbox holds clustered geometry that does not fit
in memory on a target it must run on. Owner rule, 2026-10-21: a feature that fails a gate is
deferred, not declined. The Unreal 5.8.3 reference for the reopened work:
`Engine/Source/Runtime/Engine/Private/Rendering/NaniteStreamingManager.cpp` sets a 512 MB streaming
pool (lines 57-61), at most 128 pending pages (line 82) and at most 128 page installs per frame
(line 90).

**The precondition §1 names is measured and not met.** No game in this repository or in the sandbox
holds an asset that does not fit in memory on a target it must run on. The densest thing the batch
built is the quarry's `virtual` arm — 3.5 million source triangles, 57,041 clusters, a 53 MB `.glb`
— and it holds about **46 MB of index buffers over 79 attributes plus 130 MB of vertex data** on an
8 GB card, with the whole payload resident for the whole route. There is nothing to stream.

Streaming is the most interesting part of every source this batch mines and it is the part with no
caller. An export with no caller does not ship. The measurement that opens this is a memory number
from a real game on a real device, and it does not exist yet.

**Goal: geometry the camera has not asked for is not in memory, and the geometry it asks for arrives
without a hitch.**

**Complexity:** +2 residency and eviction in the frame path, +2 asynchronous I/O across web and
native file systems, +1 a compressed page format, +1 the hitch budget = **6 → HIGH mode.**

## 1. The precondition, stated first because it is the reason this is last

**This does not open until a game in this repository or in the sandbox holds an asset that does not
fit in memory on the target it must run on.** Streaming is the most interesting part of every source
this batch mines and it is the part with no caller. An export with no caller does not ship — the
batch has already deferred one PRD on exactly that ground.

The measurement that opens it is a memory number from a real game on a real device, not an argument
about scale.

## 2. The shape, mined from Nyx

Fixed-size pages of clusters; the selection kernel writes a request for pages it wanted and did not
have; the host services requests asynchronously, decompresses, uploads, and updates a residency
table the kernel reads next frame; least-recently-wanted pages are evicted under a budget.

Two things must be true and are not free:

- **A missing page is not a hole.** The cut falls back to the coarsest resident ancestor, always
  present, so a page that has not arrived shows lower detail and never background.
- **The budget is the game's.** A residency budget in megabytes is a number the game sets. The
  framework enforces it and reports what it evicted; it does not choose it.

Platform I/O is the framework's problem — a browser fetch and a native file read are the same call
to the game. That is the seam this framework exists to own, and the reason this cannot be a game's
own code.

## 3. Acceptance criteria

- [ ] **AC1 — the precondition is documented.** The game, the asset, the device and the memory
      number that opened this PRD are named before any code is written.
- [ ] **AC2 — a missing page shows coarser, never emptier.** A test starves the residency set to one
      page and asserts the route renders with no background pixel through a closed body.
- [ ] **AC3 — the budget holds.** Resident bytes stay under the game's budget across the whole
      route, asserted per frame.
- [ ] **AC4 — no hitch.** Frame p99 over the route with streaming on is within a stated margin of
      the fully-resident run. Streaming that trades a steady frame for a stutter every few seconds
      is a regression, whatever it saves.
- [ ] **AC5 — both file systems.** Browser and packed desktop native both service requests, in the
      same commit, from the same game source.
