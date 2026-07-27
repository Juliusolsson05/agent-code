# Claude `queue-operation` corpus — catalog

Regenerate: `npx tsx --tsconfig tsconfig.web.json scripts/extract-queue-operations.mts`

Fixtures replay by walking `events` in order — the interleaving of ops and
committed `user` entries **is** the evidence, which is why they share one array.
See `docs/decomposition/claude-queue-reconciliation.md` for the design this
corpus exists to pin.

## Measured over 1916 local transcripts, of which 220 carry queue ops

Regenerate: `… scripts/extract-queue-operations.mts --measure`. These drift upward
as the local corpus grows — a small delta is expected, a large one is a finding.

```
enqueue: 2010 records / 1774 runs (7.8% multi-item)   content present: 2010/2010 = 100%
dequeue:  897 records /  787 runs (4.8% multi-item)
remove:  1093 records /  983 runs (9.1% multi-item)  <- most frequent departure
popAll:     1 record  /    1 run                     content logged; unhandled pre-fix
task-notifications carrying <task-id>: 1045/1045 = 100%
```

Two measurements that overturned the working hypothesis, recorded because both
are counter-intuitive and the next person will otherwise re-assume the wrong
thing:

1. **Batch drains are a minority.** 95% of `dequeue` runs are single-item. A
   design built purely around cohort-batching would be over-fitted.
2. **`remove` outnumbers `dequeue`.** That ratio is what forced finding its real
   emit site (`query.ts:1642`, the mid-turn attachment drain) rather than
   assuming the Ctrl+B path was the only one.

## Delivery observability, split by the departure op that followed

The measurement that decided the algorithm. "Observable" = the enqueued item
later appears as a committed `user` entry (`<task-id>` match for notifications,
normalized 48-char prefix for prompts).

| | `dequeue` | `remove` |
|---|---|---|
| task-notification | **610/619 = 98.5%** | **13/411 = 3.2%** |
| prompt | 241/278 = 86.7% | 230/678 = 33.9% |

`dequeue` delivers a queued item as a turn input and it lands in the transcript
verbatim. `remove` consumes it as a mid-turn **attachment**, and attachments are
never written to the JSONL. So identity is available for one op family and
structurally absent for the other — the reconciler uses evidence where it
exists and the cohort rule where it does not, and records which it used.

## Priority table (provenance)

Priority is set **per emit site, not per mode**. This is the table
`claudeQueue/priority.ts` implements; every row was read from the vendored
source, and the `MONITOR_TOOL` row was additionally confirmed against the
installed binary because the source leaves the flag unresolved.

| Emit site | mode | priority | Evidence |
|---|---|---|---|
| `handlePromptSubmit` — user prompt / bash | `prompt`/`bash` | **next** | `enqueue()` default, `messageQueueManager.ts:129` |
| `LocalShellTask.enqueueShellNotification` — **background command completed** | `task-notification` | **next** | `LocalShellTask.tsx:169` is `feature('MONITOR_TOOL') ? 'next' : 'later'`; `strings` on `~/.local/share/claude/versions/2.1.220` resolves it to `priority:"next"` and carries the `Monitor "…" stream ended` literals that only exist when the flag is on |
| `LocalShellTask.startStallWatchdog` | `task-notification` | **next** | `LocalShellTask.tsx:92`, unconditional |
| `LocalAgentTask` — *Agent "X" finished* | `task-notification` | later | `enqueuePendingNotification()` default, `messageQueueManager.ts:143` |
| `RemoteAgentTask`, `LocalMainSessionTask`, `task/framework`, `utils/hooks`, `useCancelRequest` | `task-notification` | later | same default |
| `useScheduledTasks`, `processSlashCommand` | `prompt` | later | explicit `priority: 'later'` |

**The consequence, and the whole bug:** `<task-notification>` maps to *both*
buckets, split by producer — background-command completions are `next`,
agent/workflow completions are `later`. Scoring them all `later` is why a mixed
queue drops the wrong item.

## Departure semantics

| op | Emit site | Removes | Content logged |
|---|---|---|---|
| `dequeue` | `queueProcessor.processQueueIfReady` (mode cohort), `print.ts` loops, `killShellTasks` (agentId cohort) | delivered as its own turn input | no |
| `remove` | `query.ts:1642` mid-turn attachment drain (priority ≤ next, or ≤ later after Sleep; `mode ∈ {prompt, task-notification}`; non-slash; thread-scoped) | delivered as attachments | no |
| `remove` | `REPL.tsx:2532` Ctrl+B backgrounding | task-notifications only | no |
| `popAll` | `popAllEditable` (UP/ESC) | editable commands only — notifications deliberately stay | **yes** |
| *(none)* | `clearCommandQueue()` — `useCancelRequest.ts:249`, ctrl+x ctrl+k | everything | n/a — **logs nothing** |

The last row is why `stale-unattributed` exists: no evidence is emitted, so no
reconciler can attribute it. 1.5% of notifications (16 items), concentrated in 9 of 220
sessions (max 4 per session).

## Fixtures

| File | What it pins |
|---|---|
| `divergence-stranded-background-commands.json` | The reported bug. Reconstruction ends holding two *Background command …* notifications while Claude held two *Agent … finished*. Background-dominant (147 vs 16). |
| `divergence-agent-dominant.json` | The mirror: 87 agent completions against 10 background commands. Pins that the `later` cohort is not over-drained when it dominates. |
| `remove-dominant-balanced-mix.json` | Remove-dominant (21 removes vs 15 dequeues) with a balanced mix — the profile that made `query.ts:1642` the real emit site rather than the Ctrl+B path. |
| `remove-is-not-persisted.json` | Ground truth for the asymmetry: `dequeue` → a `user` entry carrying the notification verbatim; `remove` → nothing. |

**No `popAll` fixture.** The single recorded `popAll` in the local corpus came
from an unrelated project and is not publishable under the source rule below.
`popAll` is covered by a synthetic unit case instead. If an agent-code session
ever produces one, add it — it logs its content, so it is the one departure
that needs no inference at all.

## What is publishable, and why the corpus looks synthetic

These fixtures are committed to a **public** repository, so three rules bound
what enters them. All three are enforced in the extractor, not by review.

1. **Agent-code sessions only.** A transcript from any other project is
   unrelated work — other codebases, other clients, personal material — and
   none of it is evidence about Claude's queue that an agent-code session
   cannot supply. The extractor throws on a non-agent-code source.
2. **No free-typed prose.** Every prompt is replaced by a stable synthetic
   token, and the committed entry that delivered it gets the *same* token.
   Matching is `normalize(committed).includes(prefix48(enqueued))`, so
   substituting identically on both sides preserves every attribution decision
   while publishing none of the operator's writing. Turns that deliver nothing
   become inert filler — they must stay present, because they advance the
   settle window that bounds a dequeue debt, but they must not match anything.
3. **No `<result>` bodies.** A subagent's written report is the only free-form
   field in an otherwise machine-generated payload, and the reconciler never
   reads it — it correlates on `<task-id>` and derives priority from
   `<summary>` plus the presence of `<status>`.

What survives is what the corpus is actually for: the operation sequence, the
interleaving of departures and committed entries, and the machine-generated
notification payloads that carry correlation identity.

The first version of this corpus honoured none of these and would have
published ~283k characters of prompts from three unrelated projects.

## Redaction — two gates, and why

The extractor **throws** rather than emitting a suspect fixture, through two
independent gates:

1. **Key-based** — `findSensitiveSurvivors`, reused from the rendering redactor
   rather than re-implemented (a second copy of that regex is how a live token
   gets committed). Strips values sitting under a secret-looking key name.
2. **Value-shaped** — `SECRET_PATTERNS` in the extractor.

Gate 2 exists because of a real miss, recorded here so nobody removes it as
redundant: the first run passed gate 1 cleanly and was rejected by GitHub push
protection carrying a live Anthropic key, an OpenRouter key and a GitHub PAT.
Gate 1 was not wrong — it was blind. **Queue content is prose**, whatever the
user typed, including the times they pasted a key into a prompt, and prose has
no keys to gate on. Any future fixture family built from free-typed content
needs a value-shaped pass for the same reason.

The pattern list is deliberately explicit rather than one clever catch-all: a
precise pattern that misses a novel shape is recoverable (push protection is
the backstop), while an over-broad one silently shreds the `<task-id>` /
`<tool-use-id>` correlation values the corpus exists to exercise.

Home paths are anonymized in all three forms the username appears in:
`/Users/name`, the `-Users-name` slug Claude embeds in scratchpad paths, and the
bare username.
