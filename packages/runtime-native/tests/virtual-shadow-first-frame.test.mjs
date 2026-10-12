import assert from "node:assert/strict";
import { test } from "vitest";
import { assertVirtualShadowFirstFrameProof } from "../conformance/scenes/shared/virtual-shadow-first-frame.js";

test("virtual shadow first frame proof rejects missing submissions and destroyed textures", () => {
  const stats = { frame: 1, levels: 3, rendered: 1, rendersTotal: 1 };
  assert.doesNotThrow(() => assertVirtualShadowFirstFrameProof(stats, null));
  assert.throws(() => assertVirtualShadowFirstFrameProof(undefined, null), /not observed/u);
  assert.throws(() => assertVirtualShadowFirstFrameProof({}, null), /not observed/u);
  assert.throws(() => assertVirtualShadowFirstFrameProof({ ...stats, frame: 2 }, null), /first frame/u);
  assert.throws(() => assertVirtualShadowFirstFrameProof({ ...stats, rendered: 0 }, null), /submit/u);
  assert.throws(() => assertVirtualShadowFirstFrameProof(stats, undefined), /observation missing/u);
  assert.throws(() => assertVirtualShadowFirstFrameProof(stats, { message: "Destroyed texture" }), /Destroyed texture/u);
});
