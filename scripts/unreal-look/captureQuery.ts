/**
 * The query a still is captured with. A still is the converged room, so the GI cache is baked in one call unless the
 * run names its own `giProgressive`: a progressive bake uploads a provisional cache first, and a page that did so
 * renders the settled room differently from one that uploaded only the final cache (PRD-649: the same texture
 * bytes, a different frame, L7 sunlit-room mean 1.5 to 4 levels, cornell black patches on the walls).
 */
export function captureQuery(env: Record<string, string | undefined> = process.env): string {
  const query = env.TN_UNREAL_LOOK_QUERY ?? "";
  return /[?&]giProgressive=/u.test(query) ? query : `&giProgressive=0${query}`;
}
