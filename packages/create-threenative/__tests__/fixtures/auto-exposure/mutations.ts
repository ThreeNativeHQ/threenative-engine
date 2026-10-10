import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

export type ExposureMutation = "linear" | "disabled" | "meter" | "clock" | "consumer";
const replacements: Record<ExposureMutation, readonly [string, string]> = {
  linear: [
    "mix(old, goal, mix(normal, float(1), cut))",
    "mix(old.negate().exp2(), goal.negate().exp2(), mix(normal, float(1), cut)).log2().negate()",
  ],
  disabled: [
    "    const renderer = frame.renderer;",
    "    if (!this.settings.enabled) return;\n    const renderer = frame.renderer;",
  ],
  meter: [
    "const luminance = decode(measure.x.exp2());",
    "const luminance = decode(measure.x.exp2()).mul(2);",
  ],
  consumer: ["const exposure = options.autoExposureEnabled", "const exposure = false"],
  clock: [
    'Reflect.set(globalThis, PLAYTEST_CLOCK_GLOBAL, "wall-clock");',
    "Reflect.deleteProperty(globalThis, PLAYTEST_CLOCK_GLOBAL);",
  ],
};

/** Mutations are confined to disposable fixture builds. Shipped source is never rewritten. */
export function mutateExposureSource(source: string, mutation: ExposureMutation): string {
  const [before, after] = replacements[mutation];
  if (source.includes("// PRD339 mutation:") || source.split(before).length !== 2)
    throw new Error(`Exposure mutation ${mutation} requires exactly one unchanged source seam.`);
  return `// PRD339 mutation: ${mutation}\n${source.replace(before, after)}`;
}

export function exposureMutationPlugin(
  mutation: ExposureMutation,
  record: (value: {
    mutation: ExposureMutation;
    sourceSha256: string;
    mutatedSha256: string;
  }) => void,
): Plugin {
  let count = 0;
  return {
    name: `prd339-${mutation}`,
    enforce: "pre",
    transform(source, id) {
      const suffix =
        mutation === "consumer"
          ? "/template-assets/worldEnvironment.ts"
          : mutation === "clock"
            ? "/fixtures/auto-exposure/main.ts"
            : mutation === "disabled"
              ? "/template-assets/autoExposure.ts"
              : "/template-assets/exposureGraph.ts";
      if (!id.endsWith(suffix)) return;
      const code = mutateExposureSource(source, mutation);
      count++;
      record({
        mutation,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        mutatedSha256: createHash("sha256").update(code).digest("hex"),
      });
      return { code, map: null };
    },
    buildEnd(error) {
      if (error === undefined && count !== 1)
        throw new Error(`Exposure mutation ${mutation} changed ${count} modules; expected one.`);
    },
  };
}

/** Pre-PRD-571 template sources: the clamped 1x1 mean meter, the red control for the histogram. */
export const meanMeterBaselineRef = "2d212479255cf725f64343dc72aa2eafe9b7b92d";
const baselineFiles = ["autoExposure", "exposure", "exposureGraph"];

/** Serves the baseline meter from git for one disposable fixture build; shipped source is untouched. */
export function meanMeterBaselinePlugin(ref: string = meanMeterBaselineRef): Plugin {
  const served = new Set<string>();
  return {
    name: "prd571-mean-meter-baseline",
    enforce: "pre",
    load(id) {
      // The baseline has no histogram to probe; keep the page's dynamic import resolvable.
      if (id.endsWith("/fixtures/auto-exposure/histogramProbe.ts"))
        return "export const runHistogramProbe = async () => {};";
      const file = baselineFiles.find((name) => id.endsWith(`/template-assets/${name}.ts`));
      if (file === undefined) return;
      served.add(file);
      return execFileSync(
        "git",
        ["show", `${ref}:packages/create-threenative/template-assets/${file}.ts`],
        {
          encoding: "utf8",
        },
      );
    },
    buildEnd(error) {
      if (error === undefined && served.size !== baselineFiles.length)
        throw new Error(
          `Mean-meter baseline served ${served.size} of ${baselineFiles.length} modules.`,
        );
    },
  };
}
