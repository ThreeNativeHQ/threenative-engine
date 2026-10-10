// PRD-506: the catalog refusal is a compile error, before an unsupported export runs.
// CatmullRomCurve3 is now shipped; DepthTexture remains explicitly unsupported.
import { DepthTexture } from "three";
console.log(new DepthTexture(1, 1).isDepthTexture);
