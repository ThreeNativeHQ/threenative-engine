# Improvement round ledger — round `<n>` — `<date>`

Round: `<n>`
Date: `<YYYY-MM-DD>`
Framework commit: `<sha>`
Framework version: `<version>`
Genres: `<comma-separated genre slugs>`
Budget: `<rounds, tokens, or time the user granted>`
Stop condition met: `<none yet | parity | budget | plateau | blocked | kill switch | void>`
Next action: `<the single next command or step, or None if the round is closed>`

A blank, `TBD`, or `<placeholder>` value is a failed round, not a round with a gap. Use
`unmeasured` where a step genuinely did not run, and say why in the notes.

## Arms

One row per genre per arm. Both arms of a genre must share a brief hash and a proof hash.

| Genre | Arm | Archive | Brief SHA-256 | Proof SHA-256 | Proof passed/total | Instrument visual | User LOC | Source files | Reach rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<genre>` | `framework` | `<archive, unmeasured, or pending>` | `<hash or unmeasured>` | `<hash or unmeasured>` | `<n/n or unmeasured>` | `<1-5 or unmeasured>` | `<number or unmeasured>` | `<number or unmeasured>` | `<decimal or unmeasured>` |
| `<genre>` | `vanilla` | `<archive, unmeasured, or pending>` | `<hash or unmeasured>` | `<hash or unmeasured>` | `<n/n or unmeasured>` | `<1-5 or unmeasured>` | `<number or unmeasured>` | `<number or unmeasured>` | `n/a or unmeasured` |

## Column verdicts

Framework arm wins a column when it is at least as good as the vanilla arm. Reach is
recorded, never gated.

| Genre | Functional | Visual | Cost | Verdict |
| --- | --- | --- | --- | --- |
| `<genre>` | `<win / tie / loss / unmeasured>` | `<win / tie / loss / unmeasured>` | `<win / tie / loss / unmeasured>` | `<parity or better / vanilla wins / unmeasured>` |

## Gap list

One row per column the vanilla arm won. No losses means one row saying `None`, so the
absence is an observation rather than an empty table.

| # | Genre | Column | What vanilla did better | Evidence | Smallest change that would close it |
| --- | --- | --- | --- | --- | --- |
| `None` | `None` | `None` | `None` | `None` | `None` |

## Dispositions

Every gap row gets exactly one disposition, decided before any code is written.

| Gap # | Disposition | 20-line verdict | Named live caller | PRD | Reason if rejected |
| --- | --- | --- | --- | --- | --- |
| `None` | `None` | `None` | `None` | `None` | `None` |

## Deletions this round

`AGENTS.md` rule 2. Any export that no fresh uninformed build reached for is deleted in the
round that discovers it.

| Export | Rounds unreached | Deleted? | Evidence |
| --- | --- | --- | --- |
| `None` | `0` | `no — no completed prior round to compare` | `unmeasured` |

## Gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | `<pass / fail with the first error>` |
| Lint | `pnpm lint` | `<pass / fail>` |
| Test | `pnpm test` | `<pass / fail>` |
| Budgets | `pnpm budgets` | `<pass / fail with the exceeded cap>` |

## Firewall attestation

| Rule | Held? | Evidence |
| --- | --- | --- |
| Arms built in separate contexts | `<yes / no / pending>` | `<two agent ids, two directories>` |
| Neither builder saw the sealed proofs | `<yes / no / pending>` | `<proofs copied in after the build>` |
| Judge was fresh, read-only, blind to arm | `<yes / no / pending>` | `<bundle path, reveal path, judge agent id>` |
| Lead agent wrote no game code | `<yes / no / pending>` | `<observation>` |

A `no` on any row voids the round's comparison. Record it as void and rebuild; do not
publish the numbers with a caveat.

## Notes

- `<caveats, sampling concerns, anything a later round should not have to rediscover>`
