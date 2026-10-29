---
name: steer-agent-docs
description: Rewrite this repository's AGENTS.md files from evidence — mine recent Claude and Codex session transcripts for what the owner actually corrected, cut stale and machine-specific instructions, push subtree detail into nested AGENTS.md, and convert repeated traps into scripts with red-green tests. Use when asked to trim, refresh, de-bloat or re-steer AGENTS.md/CLAUDE.md, or when a rule in them turns out to be wrong. Not for ordinary feature work.
---

# steer-agent-docs

Agent instructions rot in one direction: they grow. Every incident adds a paragraph and
nothing ever deletes one, until the file that was supposed to steer a model is longer than
what it steers. This is the procedure for putting one back on a page — from evidence, not
from taste.

**Target: 60–100 non-blank lines in the root file.** Everything else has a home.

## 1. Mine what the owner actually corrected

Do not start from the file. Start from what went wrong.

```sh
# Claude: every human-typed message in this project, deduplicated
cd ~/.claude/projects/<project-slug>/
for f in *.jsonl; do
  jq -r 'select(.type=="user" and (.isMeta|not)) | .message.content
         | if type=="string" then . else (map(select(.type=="text").text)|join(" ")) end' "$f"
done | grep -v '^<' | grep -v '^\[Request' | awk 'length($0)>3 && length($0)<600' | sort -u

# Codex, same repo
cd ~/.codex/sessions/<year>/<month> && grep -rl "<repo-name>" */*.jsonl
```

Read for the same complaint twice. A one-off is a mood; a repeat is a rule. In one pass this
surfaced "red green test all these rendering bugs", "AGENTS WILL USE THIS FRAMEWORK", "it
shouldnt be on this folder", "no one needs to know about the pixel 8" — four rules the file
did not have, none of which anyone would have invented from reading the file.

Also mine the *cost*: transcript lines where an agent burned a run on something the file
could have prevented (a killed shell, a false red, a device lane recorded as unavailable
that was on disk). Each one is either a new line in the file or, better, step 5.

## 2. Verify every surviving instruction before you keep it

Read the file top to bottom and put each claim in one of three buckets, checking, not
recalling:

- **True and load-bearing** — keep, compressed to its rule.
- **True and narrow** — move to the subtree that owns it (step 3).
- **Stale or false** — delete, and say so in the commit.

Check the cheap way: `ls` the paths it names, run the command it prescribes, `grep` for the
tool it claims you have. In one pass this repo's root file claimed `engine_search_capabilities`
was in the agent's tool list; the MCP server is wired by a scaffolded project's `.mcp.json`
and not by the repository at all. It also said physical Android hardware was open, months
after the phone measurements it cites elsewhere.

**History is not a rule.** Paragraphs explaining why a rule used to exist, which section of
the charter binds it, or what a migration moved where — those are commit messages wearing a
rule's clothes. Keep the rule, delete the history.

## 3. Push detail down, but leave a signpost up

Nested `AGENTS.md` files load only once an agent is already inside that subtree, which makes
them the right home for detail and the wrong home for discovery. So:

- Detail goes to the owning subtree — the CLI to its package, device lanes to the runtime,
  filing rules to `docs/PRDs/`.
- The root keeps **one line naming the capability and where it lives**, so an agent knows a
  thing exists before it has a reason to open the folder. A capability nobody knows about is
  rebuilt by hand; that is the failure this repo has paid for repeatedly.
- The root also keeps the handful of invocations an agent runs constantly, in full. A pointer
  costs a file open on the operation you do fifty times a day.

## 4. Write for a public repository on someone else's machine

Nothing in a tracked file may assume this machine: no `~/projects/...` paths, no device
model, no account limits, no "adb is at". Write the capability ("a physical device is the
evidence of record"; "the SDK is often installed but off `PATH`") and keep the operator's
actual paths in memory, where they belong. A machine-specific instruction reads as a general
rule and sends a contributor chasing a path they do not have.

## 5. A trap that keeps biting becomes code, not a paragraph

The strongest edit is deleting a warning by making it impossible to hit. Three lines telling
agents not to use `xvfb-run` became one portable wrapper plus a spec: it passes the command
through where the OS already has a display, refuses loudly where it cannot get one, and
propagates the real exit status. Same for "can this machine even run this?" — that is a
`doctor` command, not a paragraph.

Red-green, always, including for a shell script:

1. Write the test that reproduces the trap. Run it. **Paste the red.**
2. Fix it. Run it. **Paste the green.**
3. Both in the same commit.

Any escape hatch you build must fail closed: refuse with an install hint rather than run
blind, because a silent fallback manufactures a green that costs more than the red did.

## 6. Land it

```sh
pnpm sync:agents            # CLAUDE.md mirrors are generated; CI runs --check
pnpm typecheck && pnpm lint && pnpm test
```

Commit promptly and in pieces. Another agent may be working in the same tree — during one of
these passes a peer's commit reverted every uncommitted doc edit, which is exactly why the
root file now ends by telling agents to commit as they go.

The commit message says what was **removed and why it was wrong**, not only what was added.
That is the part the next reader needs, and the part a diff of a rewritten file will not show.
