# Texture provenance (shooter / Bayview)

Albedo files come from an image model through `scripts/reference.mjs` (OpenRouter). Normal maps come from the albedo by script. Date: 2026-10-26.
Each albedo was generated at 1024 x 1024 px as JPEG, converted to greyscale, made seamless with a 64 px wrap blend on both axes, resized to 512 x 512 px and saved as WebP (quality 82). The game takes only the structure: `src/render/surface.ts` divides each sample by the texture's mean, so the palette sets the colour. No key or account data is stored here.

Every prompt ends with: "Seamless tileable texture, square, viewed straight on (orthographic, top-down), evenly flat lit, no shadows, no lighting gradient, no vignette, no perspective, no text, no logo, no objects. Neutral colour, no warm or yellow cast. Photographic PBR albedo material scan."

| file | kind | model or source | prompt | date | cost USD | size px | bytes |
|---|---|---|---|---|---|---|---|
| bay-plaster.webp | albedo | google/gemini-3.1-flash-lite-image | Whitewashed lime plaster wall of a Mediterranean town: fine sand-float texture, faint trowel marks, subtle hairline cracks, slight patchy wear, nearly white neutral grey-white. | 2026-10-26 | 0.0333 | 512x512 | 18586 |
| bay-pavement.webp | albedo | google/gemini-3.1-flash-lite-image | Grey limestone street paving flags, rectangular stones about 40 by 60 cm in a running bond, thin mortar joints, gentle wear and small chips, neutral light grey. | 2026-10-26 | 0.0333 | 512x512 | 12210 |
| bay-wood.webp | albedo | google/gemini-3.1-flash-lite-image (8 px border crop) | Weathered grey pine deck planks running vertically, visible grain and knots, narrow gaps between boards, sun-bleached neutral grey-brown. | 2026-10-26 | 0.0333 | 512x512 | 46724 |
| bay-metal.webp | albedo | google/gemini-3.1-flash-lite-image | Painted steel sheet, light grey paint with fine brushed grain, tiny scratches and a few chipped spots, faint streaks, neutral grey. | 2026-10-26 | 0.0333 | 512x512 | 8924 |
| bay-ground.webp | albedo | google/gemini-3.1-flash-lite-image | Smooth poured concrete ground slab, fine aggregate speckle, faint stains and patchy wear, a few fine cracks, neutral light grey. | 2026-10-26 | 0.0333 | 512x512 | 21862 |
| bay-plaster-normal.webp | normal | derived from bay-plaster.webp (blur 0.8 px, wrap-around Sobel, strength 3) | - | 2026-10-26 | 0.0000 | 512x512 | 46462 |
| bay-pavement-normal.webp | normal | derived from bay-pavement.webp (blur 0.8 px, wrap-around Sobel, strength 6) | - | 2026-10-26 | 0.0000 | 512x512 | 55202 |
| bay-wood-normal.webp | normal | derived from bay-wood.webp (blur 0.8 px, wrap-around Sobel, strength 5) | - | 2026-10-26 | 0.0000 | 512x512 | 102794 |

Cost of the files kept: 0.1665 USD. Total spent including two billed attempts lost to a JPEG/extension mismatch: about 0.2331 USD (7 billed requests of 10 made).

Total bytes of the 8 image files: 312764 (plus this file).
