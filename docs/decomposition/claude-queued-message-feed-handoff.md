# Claude Queued-Message Feed Handoff — Staged Decomposition

> **Status:** corrected after recorded-data review and again after independent
> PR review found an exact-evidence ordering hole; implementation approved on
> 2026-08-27.
>
> **Issue:** #665. Related umbrella: #339.
>
> **Scope:** Claude prompt-mode `queued_command` attachments, their feed
> ownership, and the exact queue attribution evidence they provide. Queued
> slash commands are separate because Claude does not encode them as
> `queued_command` attachments.

## Why staged decomposition applies

Agent Code is well above the size threshold, and this failure crosses three
sources of truth:

1. `queue-operation` reconstructs pending membership. Newer `remove` records
   carry item content, while 355/1,558 recorded legacy removes omit it.
2. Claude persists a consumed queued command as a durable
   `attachment/queued_command` with the missing identity and provenance.
3. Agent Code's mapper and ledger discard that durable entry, so the renderer
   never receives a candidate.

The first decomposition incorrectly proposed synthesizing a local handoff row.
Recorded rendering bundles falsified its premise: the durable row already
exists. This revision changes the substrate before implementation instead of
patching forward.

The repository already has transcript collection, bundle capture, redaction,
and queue-corpus extraction. This work reuses and, where necessary, extends
those paths. It does not add another recorder.

## A — concrete trusted starting point

### Acceptance works

- `claudeSession.ts` treats a committed `user` row or
  `queue-operation/enqueue` as prompt acceptance. The prompt reached Claude.
- Claude has `usesOptimisticUserEcho: false`, so Agent Code correctly does not
  paint a speculative row while the prompt is pending.

### The durable artifact exists

`testing/fixtures/rendering-bundles/2026-06-14T14-25-07-012-a8ad1ebb.json`
contains three recorded transitions:

| Enqueue | Remove | Attachment | Invariant |
|---:|---:|---:|---|
| 7 | 8 | 13 | prompt equals enqueue; remove/attachment timestamp matches; no matching conversation user |
| 27 | 28 | 30 | same |
| 62 | 63 | 70 | same |

Each attachment is `type: "attachment"` with
`attachment.type: "queued_command"`, a stable UUID, timestamp, and original
prompt. Entries 55/56/60 prove the working comparison:
`dequeue → committed user` already paints normally.

The frozen rendering corpus contains 15/48 queue-bearing bundles and 28
`queued_command` attachments: 22 prompt-mode, 6 task-notification, all with a
UUID and timestamp.

A content-free structural census over the existing local Claude corpus found
1,058 durable records across versions 2.1.100–2.1.247:

- 772 prompt and 286 task-notification;
- 1,058/1,058 external-user, UUID-bearing, and timestamped;
- 474 human-origin prompts, 296 legacy prompts without origin, and 2 peer/meta;
- 1,044 string prompts and 14 block-array prompts.

These aggregate counts are evidence, not a new fixture source. Stage 1 makes
the existing measurement path reproduce the relevant split.

### Agent Code drops it

1. `providers/claude/renderer/transcript/mapper.ts` admits only conversation
   and compaction entries. Live, history, preview, and remote therefore map
   queued-command attachments to `entries: []`.
2. `classifyClaudeDurableEntry` recognizes only compact boundary/summary.
3. If an attachment bypassed the mapper, the committed collector would reject
   it as `not-conversation`.
4. `useIpcSubscriptions.ts` applies the preceding remove and updates
   `queuedMessages`; no surviving feed candidate owns the durable attachment.

### Queue attribution also ignores the evidence

`applyRemove` ignores `remove.content` even though 1,203/1,558 recorded removes
carry it, then guesses a victim immediately. In an ambiguous mixed queue it
prefers a notification over a prompt because guessing away user work is the
more dangerous direction. The recorded
`divergence-stranded-background-commands.json` events 111–116 contain a prompt
and notification together and then remove the prompt by exact logged content;
the current reconciler removes the notification instead.

For 355 legacy content-free removes, the later queued-command attachment
contains the consumed command's exact prompt and mode. The three June bundle
transitions prove that join. The July bundle previously cited here does not
prove a mixed queue at remove time: its notifications were enqueued after the
remove, so it is retained only as another durable prompt shape.

### Existing fixtures have different proof strength

- `fixtures.queueHandoff.test.ts` manually supplies an
  `optimistic-codex-user:*` row under a Claude label. It proves echo-provider
  ledger reconciliation, not the Claude producer path.
- `testing/fixtures/queue-operations/*.json` preserves operation topology,
  but omits raw type, timestamp, provenance, and attachment payload. It cannot
  drive durable rendering.
- Rendering bundles retain those real shapes and are the primary end-to-end
  fixture family for this fix.

## Root cause

```text
queue-operation/enqueue ──▶ ClaudeQueueState.pending ──▶ QueueStrip
                                  │
                                  │ exact content when present;
                                  │ otherwise bounded evidence debt
                                  ▼
                            guessed queue victim

Claude JSONL: attachment/queued_command (UUID + prompt + provenance)
        │
        ├── mapper rejects it
        ├── durable classifier does not recognize it
        └── ledger gets no candidate ──X──▶ user bubble
```

The missing link is durable attachment admission, not local synthesis:

- queue reconciliation uses the attachment to identify what stopped pending;
- the ledger uses the attachment itself as the committed visible owner when
  provenance proves it is a human prompt.

## D — concrete observable end state

1. A queued prompt remains only in `QueueStrip` while pending.
2. A consumed human, non-meta prompt attachment becomes exactly one ordered
   user bubble using its durable UUID and timestamp.
3. No optimistic twin is created. Repeated text stays distinct by UUID.
4. Task-notification, peer, and meta attachments never paint as user-authored.
5. `dequeue → committed user` keeps the existing committed row as sole owner.
6. Logged remove content wins when present; otherwise attachment identity
   removes the exact item. Removes with neither retain a bounded fallback.
7. Live, initial history, older pagination, preview, and remote agree through
   the shared mapper/classifier.
8. The provider painter handles every admitted candidate and the ledger bridge
   reports zero drops.
9. No unbounded history, per-operation transcript scan, or retained text index
   is added. Entries remain inside the 2,000-entry/32 MiB window.
10. Corpus changes are manually triaged; no fixture is blindly blessed.

## Intermediate stages

### Stage 1 — correct evidence and establish red contracts

**Produces**

- Reproducible attachment/provenance measurements in the existing
  `extract-queue-operations.mts --measure`/catalog path, replacing the false
  “attachments never reach JSONL” claim.
- Recorded red tests for prompt admission, the working dequeue comparison,
  notification exclusion, and mixed-queue exact attribution.
- Corrected scope for `fixtures.queueHandoff.test.ts` and reduced queue
  fixtures.
- If peer/meta or block-array structure is absent from bundles, a hard-redacted
  projection from existing capture/redact tooling—not a new recorder.

**Verified by**

- On the untouched implementation, the prompt contract fails at mapper
  admission and produces no selected row.
- The dequeue comparison stays green.
- Every test cites a bundle and event indices or recorded redaction provenance.
- `--measure` regenerates every retained aggregate claim.

**Why separate**

The first plan and catalog overlooked attachments already in the same
transcript. Tests written after the adapter would only ratify the adapter.

**Reality check**

The stage uses the 15 queue-bearing bundles and existing local transcripts. It
adds no imagined fixture family.

### Stage 2 — isolate provider-owned queued-command admission

**Produces**

- One pure Claude adapter for `attachment/queued_command`.
- A provider-neutral durable kind such as `queued-user-prompt`, returned only
  for `commandMode === "prompt"`, `isMeta !== true`, and absent legacy or
  `human` origin.
- Mapper admission through that provider classification.
- A promoted shape route closing `TODO(system-attachment-grammar)` for only
  this subtype.

**Verified by**

- Recorded string and block-array prompts decode without losing identity.
- Task-notification and peer/meta shapes decline the user-prompt kind.
- All shared mapper call sites receive identical output.
- Malformed shapes decline safely.

**Why separate**

Raw Claude grammar must not leak into the shared ledger, queue UI, or React
components. Provider facts precede visibility ownership.

**Reality check**

The current census predicate accepts 770 human/legacy prompts and rejects 286
task notifications plus 2 peer/meta prompts.

### Stage 3 — give the durable entry one ledger and painter owner

**Produces**

- `queued-user-prompt` mapped to committed `user-text`, never
  `optimistic-submit`.
- A Claude durable row presenting the original prompt while retaining the
  attachment UUID/timestamp.
- Exhaustive bridge/debug reasons so admission cannot silently outpace paint.

**Verified by**

- The three recorded remove/attachment transitions each paint once.
- Dequeue still paints only its committed conversation row.
- Notification and peer/meta attachments paint no fake user row.
- Repeated identical prompts remain separate by UUID.
- `ledgerToFeedItems` has zero drops and classifier/painter exhaustiveness
  typechecks.

**Why separate**

Stage 2 answers what the provider artifact is. Stage 3 decides who paints it.
Combining them lets the mapper make UI policy.

**Reality check**

The selected candidate is the recorded attachment. Queue text, screen text,
synthetic UUIDs, and guessed timestamps cannot mint it.

### Stage 4 — replace remove inference with attachment identity

**Produces**

- A provider-neutral queued-command observation consumed by the pure
  `claudeQueue` reconciler.
- Exact `remove.content` attribution plus bounded legacy settlement allowing
  adjacent attachment evidence to identify the pending item before fallback.
- Distinct observed-attachment and no-attachment fallback decisions.
- IPC forwards typed evidence but contains no victim heuristic.

**Verified by**

- The recorded mixed queue fixture removes the prompt named by
  `remove.content` and preserves its notification.
- The three legacy content-free June transitions settle from their adjacent
  queued-command attachment.
- Multi-remove runs settle one item per attachment without reordering FIFO
  peers.
- A faithful Ctrl+B/no-attachment case exercises fallback.
- No-op/reference stability and queue-corpus replays remain green.
- Debt cannot retain more full content than the bounded pending queue.

**Why separate**

Feed ownership needs no queue inference; the attachment paints itself. Queue
membership still needs a pure identity-free-operation/evidence join.

**Reality check**

Settlement order comes from recorded evidence. If watcher batch boundaries are
not proven, retain conservative bounded debt rather than invent timing.

### Stage 4b — preserve invisible reconciliation state across watcher bursts

**Produces**

- A recorded three-burst regression using the June enqueue, legacy remove, and
  queued-command attachment without changing their raw order or contents.
- Session-owned queue debt that commits even when a burst changes no visible
  runtime field and therefore correctly returns the existing React runtime.

**Verified by**

- The recorded enqueue arrives first and makes the queue visible.
- The recorded content-free remove arrives alone while `awaitingAssistant` is
  already true; visible pending membership remains unchanged, but its debt
  survives the runtime no-change return.
- The recorded attachment arrives in a third burst, consumes that debt, removes
  the queue item, and appends the durable user row exactly once.
- The ordinary no-change path remains reference-stable and causes no extra
  runtime render solely to persist internal queue attribution.

**Why separate**

Stage 4 proved the pure reconciler retains debt. It did not prove that the
single IPC consumer commits queue-only state when React-visible fields are
unchanged. Combining those concerns hid the ownership boundary: the pure state
was correct, but its session-lifetime owner discarded it before the next burst.

**Reality check**

The exact June records already establish enqueue → remove → attachment. A
watcher is allowed to split adjacent JSONL lines at any boundary, so the test
changes only delivery batching—not provider data. No new recorder, synthetic
queue record, prompt, UUID, or timestamp is introduced.

### Stage 4c — prevent inferred dequeue debt from preempting exact remove evidence

**Produces**

- A line-bounded, hard-redacted projection of the recorded
  enqueue/dequeue/remove run whose content-bearing removes currently leave
  permanent residue.
- Exact-before-inference remove ordering: when `remove.content` names a pending
  item, that observed departure is applied to the original pending set and the
  older dequeue debt remains open for its own later settlement.
- A conservation contract proving every recorded enqueue ends either pending
  or in exactly one observed/inferred departure decision.

**Verified by**

- The untouched reconciler fails because the first content-bearing remove
  settles three older dequeues by cohort, consumes the exact target as an
  inference, and records no `consumed-observed` decision for that remove.
- The corrected reconciler applies all thirteen recorded exact removes as
  observed evidence, retains the three dequeue departures as debt, then
  settles those three independently without residual pending items.
- Replaying the complete queue corpus still satisfies exact conservation and
  leaves no unretirable item.

**Why separate**

Dequeue debt and content-bearing remove records prove two different
departures. Settling the older inference before inspecting the newer exact
carrier lets a guess consume the very item the carrier names, after which the
exact remove no-ops and another item survives forever. Evidence precedence is
therefore an attribution invariant, not another victim-selection condition.

**Reality check**

A fresh replay over 143 queue-bearing local transcripts found this exact
signature twice and in zero Agent Code project sessions. The primary recording
contains sixteen notification enqueues, three content-free dequeues, thirteen
content-bearing removes, and thirteen durable queued-command attachments; three
correlation identities are duplicated. Because the source belongs to an
unrelated project, the existing extractor must publish only lines 1511–1557 as
an aggressively pseudonymized structural projection: no project path, free
prose, task id, output path, or task name may enter git. This is an extension of
the existing collection/redaction path, not a second recorder or an imagined
fixture.

### Stage 5 — parity, heap verification, and delivery

**Produces**

- Live/history/pagination/preview/remote parity.
- Heap and reference-stability evidence.
- Corrected reconciliation comments/docs removing “never persisted.”
- A PR with `Fixes #665`, `Refs #339`, and independent final reviews.

**Verified by**

- Focused mapper, classifier, row, queue, ledger, live-window, history, remote,
  and renderer tests.
- Bundle corpus, queue replay, shapes, invariants, typecheck, and relevant
  renderer/system suites.
- Manual triage of every changed bundle.
- Final diff audit, synchronized Issue/PR, clean worktree, and passing CI.

**Why separate**

Admission tests do not prove reload/remote parity, and green corpus output does
not prove heap behavior.

**Reality check**

Any newly observed provider shape returns the work to Stage 1 rather than
receiving a forward conditional.

## What is isolated

The genuinely hard component remains queue attribution under:

```text
src/renderer/src/session-runtime/claudeQueue/
```

Its single production consumer is live session-runtime ingestion. It consumes
provider-neutral queue operations, committed-user observations, and
queued-command observations; it does not parse Claude grammar or render rows.

Provider grammar sits behind one Claude adapter. Mapper, classifier, renderer,
and live ingestion consume its typed projection; none duplicates raw
`attachment.*` checks.

Forbidden directions:

- QueueStrip/Feed/rows may not import `claudeQueue`.
- Rendering may not infer a remove victim.
- `claudeQueue` may not import React, IPC, feed, or Claude raw types.
- Shared ledger code may use the durable kind but not raw attachment fields.
- IPC may forward adapter evidence but not add a victim heuristic.
- History/remote may not implement separate attachment mappers.
- No local optimistic UUID is minted for a durable command.

## Heap and runtime constraints

1. Retain the attachment once in `runtime.entries`; do not copy its prompt
   into a local entry.
2. Queue decisions keep bounded preview/evidence only.
3. Remove debt stores counts/references to pending items, not content history,
   and has an explicit bound.
4. Never use `optimistic-codex-user:`; it can pin live-window trimming.
5. Match only against the bounded pending queue; no transcript scan per op.
6. Add no session-lifetime normalized-text set. UUID is identity.
7. Add no transcript/runtime `JSON.stringify`; keep the WeakMap-cached
   estimator and existing count/byte authority.
8. No-op inputs preserve references.

## Unknowns

1. **Live batch boundary:** bundles preserve raw order, not watcher delivery
   batches. Stage 4b therefore requires every internal queue-state transition
   to survive an otherwise React-visible no-op burst.
2. **`source_uuid`:** semantics/coverage are not strong enough to require it.
3. **Block arrays:** 14 recorded human prompts need supported text/image
   presentation without unproven flattening.
4. **Legacy origin:** 296 prompts lack origin/meta. They are accepted for
   compatibility; contrary evidence must revise the predicate.
5. **No-attachment remove:** Ctrl+B/future shapes need explicit fallback.
6. **Append-only decisions:** do not enlarge their payload; bounding the
   pre-existing array is separate unless measurement blocks this work.
7. **Exact evidence with older debt:** recorded runs can interleave dequeue
   debt and later content-bearing removes. Stage 4c makes their independent
   departure ownership explicit instead of assuming operation order alone can
   attribute both.

## Explicit non-goals

- Queued slash commands produce no attachment and commit as command scaffolding
  that the feed filters. They require a separate recorded contract and Issue.
- Bash commands are excluded from inline attachment drain; existing dequeue
  behavior is unchanged.
- No provider-wide optimistic echo for Claude.
- No redesign of the general ledger or queue UI.

## Fixture plan

Primary sources:

- `2026-06-14T14-25-07-012-a8ad1ebb.json`: three missing bubbles, one working
  dequeue, pending/notification negatives.
- `divergence-stranded-background-commands.json` events 111–116: a recorded
  mixed queue whose remove record carries the exact prompt content.
- `2026-07-07T13-17-20-472-5b19529f.json`: additional durable prompt shape;
  not mixed-queue proof.
- The other 13 queue-bearing bundles for variants/regression.
- Queue-operation fixtures for topology/fallback only.
- A hard-redacted structural projection of the recorded 16-enqueue / 3-dequeue
  / 13-exact-remove run for evidence precedence. Its unrelated project name
  and content remain local; only operation order, duplicate topology, priority
  class, and pseudonymous correlation equality are published.
- Existing transcripts through current redaction for provenance/block arrays
  absent from bundles.

Red-first contracts:

1. Human prompt attachment is admitted, selected as committed user text, and
   painted once at durable identity/order.
2. Dequeue plus committed user remains one row.
3. Notification attachment is not a user prompt.
4. Peer/meta attachment is not a user prompt.
5. Block-array human prompt preserves supported content.
6. Mixed queue removes the exact content-identified item; legacy content-free
   remove settles from the attachment.
7. Remove without attachment follows bounded fallback.
8. Live, cold history, older page, preview, and remote map identically.
9. Trimming reclaims admitted attachments and pagination reloads them.
10. The recorded June enqueue, legacy remove, and attachment still hand off
    correctly when each arrives in its own watcher burst.
11. A content-bearing remove applies its exact carrier before older dequeue
    debt, and the still-open debt later settles a different recorded item.

If any semantic case lacks recorded evidence, stop at Stage 1 and use the
existing collection/redaction path. Do not fill the gap with a plausible
literal.
