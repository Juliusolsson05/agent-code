# Claude `queue-operation` corpus — catalog

Regenerate: `npx tsx --tsconfig tsconfig.web.json scripts/extract-queue-operations.mts`

Fixtures replay by walking `events` in order — the interleaving of ops and
committed `user` entries **is** the evidence, which is why they share one array.
See `docs/decomposition/claude-queue-reconciliation.md` for the design this
corpus exists to pin.

## Measured over 887 local transcripts, of which 143 carry queue ops

Regenerate: `… scripts/extract-queue-operations.mts --measure`. These drift upward
as the local corpus grows — a small delta is expected, a large one is a finding.

```
enqueue: 2196 records / 1798 runs (13.6% multi-item)  content present: 2196/2196 = 100%
dequeue:  590 records /  553 runs (4.0% multi-item)
remove:  1572 records / 1260 runs (13.6% multi-item)  content present: 1217/1572 = 77.4%
popAll:     1 record  /    1 run                     content logged; unhandled pre-fix
task-notifications carrying a correlation id: 1144/1144 = 100%
```

Two measurements that overturned the working hypothesis, recorded because both
are counter-intuitive and the next person will otherwise re-assume the wrong
thing:

1. **Batch drains are a minority.** 95% of `dequeue` runs are single-item. A
   design built purely around cohort-batching would be over-fitted.
2. **`remove` outnumbers `dequeue`.** That ratio is what forced finding its real
   emit site (`query.ts:1642`, the mid-turn attachment drain) rather than
   assuming the Ctrl+B path was the only one.
3. **`remove` is versioned evidence, not uniformly content-free.** 1,217/1,572
   current-corpus records carry the exact removed content; 355 older records do
   not. Exact operation content must win when present. The durable
   `queued_command` attachment supplies adjacent identity for the legacy form.

## Durable queued-command evidence

The earlier catalog called a prompt "observable" when any later committed
`user` row contained its normalized 48-character prefix. That is a useful
dequeue heuristic but not a delivery census: repeated prompts and later prefix
collisions were counted as if they were late twins. The quoted 33.9% remove
figure was therefore not reproducible from `--measure` and did not support the
local-synthesis design that consumed it.

Claude persists the dominant remove delivery directly as
`type: "attachment"` / `attachment.type: "queued_command"`. The existing
`--measure` path now counts that durable carrier:

```
queued_command attachments: 1072
  durable identity: uuid 1072/1072, timestamp 1072/1072, external user 1072/1072
  mode: prompt 777, task-notification 295
  prompt provenance: human 479, legacy-no-origin 296, peer-meta 2
  prompt shape: string 1058, block-array 14
  versions: 45 (2.1.100 → 2.1.250)
```

For feed ownership, the recorded admissible set is prompt mode, non-meta, and
either human origin or the legacy absence of origin: 775 records in this
snapshot. Task notifications and the two peer/meta prompts are durable queue
evidence but must not paint as user-authored chat.

`dequeue` still uses a following committed user row as queue identity evidence.
`remove` should use its own content when present, otherwise the queued-command
attachment that follows it, and reserve cohort inference for the bounded case
where neither identity carrier arrives.

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
| `remove` | `query.ts:1642` mid-turn attachment drain (priority ≤ next, or ≤ later after Sleep; `mode ∈ {prompt, task-notification}`; non-slash; thread-scoped) | delivered as attachments | versioned: 1,217/1,572 recorded removes carry content |
| `remove` | `REPL.tsx:2532` Ctrl+B backgrounding | task-notifications only | same record grammar; no queued-command attachment follows |
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
| `remove-is-not-persisted.json` | Reduced queue-replay view: `dequeue` → a retained `user` identity event; `remove` → no retained event because this fixture format intentionally omits attachments. Full rendering bundles prove the durable queued-command carrier. |
| `exact-remove-after-open-dequeue-debt.json` | A recorded 16-enqueue / 3-dequeue / 13-exact-remove run with three duplicate correlations. Pins that older inferred debt cannot preempt a later exact carrier. Published as a line-bounded hard-redacted projection because the provider-level shape occurred only in an unrelated project recording. |

**No `popAll` fixture.** The single recorded `popAll` in the local corpus came
from an unrelated project and is not publishable under the source rule below.
`popAll` is covered by a synthetic unit case instead. If an agent-code session
ever produces one, add it — it logs its content, so it is the one departure
that needs no inference at all.

## What is publishable, and why the corpus looks synthetic

These fixtures are committed to a **public** repository, so three rules bound
what enters them. All three are enforced in the extractor, not by review.

1. **Full fixtures use Agent Code sessions only.** A transcript from any other
   project is unrelated work — other codebases, other clients, personal
   material — so the extractor throws before publishing it. The sole exception
   is an explicit line-bounded hard-redacted projection for a provider-level
   topology absent from every Agent Code recording. That stronger path also
   removes the source project, task ids, task names, output paths, and result
   text; only operation order, equality, duplicate topology, and priority
   survive.
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
