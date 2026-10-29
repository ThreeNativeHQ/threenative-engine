#!/usr/bin/env node
// Project-scoped ponytail activation. Runs only where this file is installed: the engine repo
// and every project `create-threenative` generates. It injects the same ruleset on session,
// prompt and subagent start so the AGENTS.md rule cannot drift out of the model's context.
//
// It is deliberately small: no mode file, no statusline, no state written outside the project.
// `PONYTAIL=off` (or removing this hook) turns it off.

if (process.env.PONYTAIL === "off") process.exit(0);

const RULESET = [
  "PONYTAIL MODE ACTIVE — laziest solution that actually works.",
  "",
  "Before writing code, stop at the first rung that holds (read the code the change touches first):",
  "1. Does this need to exist? No -> skip it (YAGNI).",
  "2. Already installed in the engine? Search `engine_search_capabilities` and inspect with `engine_capability_detail` — reuse the returned system. This rung IS the critical capability gate; a shipped node, convention, helper or subpath is the answer, never hand-write what it already does.",
  "3. Already in this game? Reuse what is in `src/`.",
  "4. Stdlib or engine convention (loadAll, addInSlices, GroundSnap, an input vector, a physics query)? Use it.",
  "5. Already-installed dependency? Use it; add none for a few lines.",
  "6. One line? One line.",
  "7. Only then: the minimum code that works.",
  "",
  "No unrequested abstractions, no boilerplate, no scaffolding for later; deletion over addition; fewest files; shortest diff once you understand the problem. Bug fix = grep every caller and fix the shared function once. Code first, then at most three short lines (`[code] -> skipped: [X], add when [Y].`).",
  "Never simplify away: understanding the problem, trust-boundary validation, error handling that prevents data loss, security, accessibility, anything explicitly requested, hardware calibration. Non-trivial logic leaves ONE runnable check behind — here that is a playtest scenario.",
  'Off: "stop ponytail" / `PONYTAIL=off`. Full rules: `.claude/skills/ponytail/SKILL.md` or `.agents/skills/ponytail/SKILL.md`.',
].join("\n");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", emit);
process.stdin.on("error", () => process.exit(0));
// Never hang a session, and never fail one: an unreadable skill or closed stdin exits quietly.
setTimeout(() => process.exit(0), 3000).unref();

function emit() {
  let event = "SessionStart";
  try {
    event = JSON.parse(stdin || "{}").hook_event_name || event;
  } catch {
    // Malformed stdin still gets the ruleset; the event name only shapes the envelope.
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: RULESET },
    }),
  );
  process.exit(0);
}
