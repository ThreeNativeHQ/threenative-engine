# PR483 / PRD614 optimized default alpine preservation

Two runs each of ground, edge, boulders and overview: 16 labelled original frames plus eight full-resolution pairs (BEFORE left, AFTER right). Original 1920x1080 pixels remain below 70px labels; pairs retain those pixels and labels with a 20px divider. Intended result: preserve default alpine appearance after lossless JPEG entropy optimization; no edits or tint. Capture provenance: headed NVIDIA Turing.

Initial judge (`prd614-visual-optimized-default.log`): overall REGRESSION, reporting blank AFTER edge/overview frames in both runs. This reported blank contradicted the actual PNGs; the presentation cause is unknown. Preserve this contradictory judgment rather than suppressing it.

Fresh pair judge (`prd614-visual-optimized-pairs.log`): all eight pairs NEUTRAL, all 16 frames visible and inspectable, no blank or missing side. Ground relief/framing/light, edge silhouette/boulder, boulder materials/shadows and overview mountain/snow/rock were preserved. The fresh judge did not open individual originals because no pair was ambiguous. This supports visual preservation only; it establishes neither a visual improvement nor a performance result and does not resolve forest proof.
