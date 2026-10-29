import type { IPlaytestHudAuditItem } from "../assertion-report.js";
import type { IEvaluationContext } from "./context.js";

export type Rgba = [number, number, number, number];

const MAX_OFFENDERS = 5;
/** Below this a background is the canvas, not a backing plate: text there is not judged. */
const JUDGED_BACKGROUND_ALPHA = 0.5;
const DEVELOPER_TEXT = /\b(debug|todo|fixme|lorem ipsum|placeholder|probe|raycast|hitbox|wall ray)\b/iu;
/** An unresolved value is the defect: `Null` can be real copy, so these three stay case-sensitive. */
const UNRESOLVED_TEXT = /\b(undefined|null|NaN)\b/u;
const COERCED_OBJECT = /\[object /u;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]: Rgba): number {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue);
}

/** WCAG 2.x contrast ratio, with the foreground alpha-composited over an opaque background first. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const alpha = Math.min(Math.max(foreground[3], 0), 1);
  const composited: Rgba = [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
  const first = relativeLuminance(composited);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function readsAsDeveloperText(text: string): boolean {
  return DEVELOPER_TEXT.test(text) || UNRESOLVED_TEXT.test(text) || COERCED_OBJECT.test(text);
}

function offenders(items: readonly IPlaytestHudAuditItem[]): Array<{ selector: string; text: string }> {
  return items.slice(0, MAX_OFFENDERS).map(({ selector, text }) => ({ selector, text }));
}

export function emitHudAudit(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.hudAudit;
  if (assertion === undefined) return;
  const items = ctx.input.report.observations?.hudAudit?.items ?? [];
  if (items.length === 0) {
    ctx.assertions.push({ details: { items: 0 }, id: "hudAudit.observed", pass: false });
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_HUD_AUDIT_UNOBSERVED",
      message: "A hudAudit assertion was evaluated against a run that reported no visible page text.",
      observedRuntimePath: "observations.json/hudAudit",
      severity: "error",
      suggestion: "Run on the browser target and make sure the page draws player-facing text in the DOM, outside a canvas.",
    });
    return;
  }

  if (assertion.noDebugText === true) {
    const found = items.filter(({ text }) => readsAsDeveloperText(text));
    const pass = found.length === 0;
    ctx.assertions.push({
      details: { checked: items.length, offenders: offenders(found) },
      id: "hudAudit.debugText",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_HUD_DEBUG_TEXT",
        message: `Developer text reached the player's HUD in ${found.length} of ${items.length} text items: ${found.slice(0, MAX_OFFENDERS).map(({ text }) => JSON.stringify(text)).join(", ")}.`,
        observedRuntimePath: "observations.json/hudAudit/items",
        severity: "error",
        suggestion: "Replace debug, TODO, placeholder and unresolved values with the copy the player should read, then rerun the scenario.",
      });
    }
  }

  if (assertion.minContrast !== undefined) {
    const judged = items.filter(({ background }) => background[3] >= JUDGED_BACKGROUND_ALPHA);
    const unjudged = items.length - judged.length;
    const worst = judged
      .map(({ selector, text, background, color }) => ({ ratio: contrastRatio(color, background), selector, text }))
      .sort((left, right) => left.ratio - right.ratio)
      .slice(0, MAX_OFFENDERS);
    const pass = worst.every(({ ratio }) => ratio >= assertion.minContrast!);
    ctx.assertions.push({
      details: { judged: judged.length, minContrast: assertion.minContrast, unjudged, worst },
      id: "hudAudit.contrast",
      pass,
    });
    if (!pass) {
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_HUD_CONTRAST",
        message: `HUD text falls below the ${assertion.minContrast}:1 contrast floor: ${worst.filter(({ ratio }) => ratio < assertion.minContrast!).map(({ ratio, text }) => `${JSON.stringify(text)} at ${ratio.toFixed(2)}:1`).join(", ")}.`,
        observedRuntimePath: "observations.json/hudAudit/items",
        severity: "error",
        suggestion: "Raise the text colour's contrast against its backing plate, or darken the plate, until every judged item reaches the floor.",
      });
    }
  }
}
