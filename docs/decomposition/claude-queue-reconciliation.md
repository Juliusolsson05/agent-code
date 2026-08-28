# Claude Queue Reconciliation — Full Implementation Plan

> **Status:** SHIPPED on this branch. All five stages are implemented; §7 keeps
> the checklist as the record of what was built. The investigation behind it is
> closed — every unknown that gated the design was answered locally against the
> vendored upstream source, the installed 2.1.220 binary, and the recorded
> queue corpus. §3 states the root cause exactly. §5 is the algorithm.
>
> **What landed:**
> `src/renderer/src/session-runtime/claudeQueue/` (the reconciler, single
> consumer `useIpcSubscriptions`), `scripts/extract-queue-operations.mts`,
> `testing/fixtures/queue-operations/` (4 recorded agent-code sessions + `catalog.md`).
> `claudeQueueReconstruction.ts` is deleted.
>
> **2026-08-27 evidence correction:** the original investigation treated every
> `remove` as content-free and every consumed attachment as non-durable. The
> recorded corpus disproves both claims: 1,217/1,572 removes carry exact content,
> and older content-free removes are followed by durable
> `attachment/queued_command` rows. The algorithm and reason names below are
> updated to the corrected substrate; the priority/fallback analysis remains
> relevant only when neither identity carrier exists.
>
> **Verification:** `npm run typecheck` clean; the full unit+renderer suite and
> 61 system tests pass, and the 50-test bundle+recording corpora are unchanged —
> no divergence to triage, nothing blessed.
>
> **For agentic workers:** REQUIRED SUB-SKILL: `staged-decomposition`. Stages use
> checkbox (`- [ ]`) syntax. Do not start a stage before its predecessor's
> artifact exists and has been verified independently.
>
> **Trigger:** "Background commands stay in notifications forever." The chips
> live in `QueueStrip`, the same strip as the prompt queue.

---

## 1. A and D

### A — what exists and is trusted

| Thing | Where | Trust |
|---|---|---|
| `queue-operation` records in Claude's JSONL | `messageQueueManager.logOperation` → `sessionStorage.insertQueueOperation` → `appendEntry` | **Trusted.** Verbatim, append-only, same file we tail. |
| Op vocabulary | `enqueue`, `dequeue`, `remove`, `popAll` | **Trusted** — measured, §2. |
| `enqueue` / `popAll` carry `content` | `logOperation(op, content)` | **Trusted. 2,196/2,196 enqueues carry content.** |
| `remove` identity is versioned | recorded JSONL | **Trusted. 1,217/1,572 carry content; 355 legacy records do not.** |
| Legacy `remove` attachment | recorded JSONL | **Trusted. Claude persists `attachment/queued_command` with prompt, mode, UUID, and timestamp.** |
| `<task-notification>` carries a correlation id | every emit site | **Trusted. 1,144/1,144 = 100%.** |
| Committed `user` entries | the transcript | **Trusted** — the `dequeue` delivery channel, §3.3. |
| `QueueStrip` | `TileLeaf/QueueStrip.tsx` | Trusted; not the bug. |

### D — the end state

1. A background-command notification leaves the strip when Claude delivered it,
   and not before.
2. A queued prompt is never removed because a *notification* left the queue.
3. Residue that genuinely cannot be attributed is **visibly marked**, never
   silently held as if pending.
4. Every departure carries a recorded reason and evidence.

---

## 2. Measurements (143 op-carrying transcripts of 887, `~/.claude/projects`)

Regenerate with `npx tsx --tsconfig tsconfig.web.json scripts/extract-queue-operations.mts --measure`.
Counts drift upward as the local corpus grows; the method is what must reproduce.

```
enqueue: 2196 records / 1798 runs (13.6% multi)  content present: 2196/2196 = 100%
dequeue:  590 records /  553 runs (4.0% multi)
remove:  1572 records / 1260 runs (13.6% multi)  content present: 1217/1572 = 77.4%
popAll:     1 record  /    1 run
task-notifications carrying a correlation id: 1144/1144 = 100%
queued_command attachments: 1072 (777 prompt, 295 task-notification; all UUID/timestamp bearing)
```

The earlier 33.9% figure counted later prefix collisions as if they proved a
specific remove delivery. It is not reproducible evidence and is retired.
There are three real identity channels: committed user rows after `dequeue`,
exact `remove.content` on newer Claude, and durable queued-command attachments
after legacy content-free removes. Cohort simulation is only the bounded last
resort.

---

## 3. Root cause — exact

### 3.1 The priority table is wrong for precisely the reported case

`inferQueuePriority` (`claudeQueueReconstruction.ts:53`) maps **every**
`<task-notification>` to Claude's `'later'` bucket. Upstream, mode does not
determine priority. The real table, read from the vendored source and confirmed
against the resolved 2.1.220 binary:

| Emit site | mode | priority |
|---|---|---|
| `handlePromptSubmit` — user prompt / bash | `prompt`/`bash` | **next** |
| `LocalShellTask.enqueueShellNotification` — **background command completion** | `task-notification` | **next** |
| `LocalShellTask.startStallWatchdog` | `task-notification` | **next** |
| `LocalAgentTask` — *Agent "X" finished* | `task-notification` | later |
| `RemoteAgentTask`, `LocalMainSessionTask`, `task/framework`, `utils/hooks`, `useCancelRequest` | `task-notification` | later |
| `useScheduledTasks`, `processSlashCommand` | `prompt` | later (explicit) |

The source has `priority: feature('MONITOR_TOOL') ? 'next' : 'later'`, and the
flag is resolved at bundle time, so the source alone cannot settle it. Evidence
from the installed binary, stated precisely because one half of it does not
reproduce by the obvious recipe:

- **Reproduces:** `strings ~/.local/share/claude/versions/2.1.220 | grep 'stream ended'`
  finds the `Monitor "…" stream ended` literals, which exist only on the
  MONITOR_TOOL branch of `rFs`/`enqueueShellNotification`.
- **Does NOT reproduce by grep:** the binary is minified with string-table
  hoisting, so `Background command ` is a table entry with no `priority:` token
  near it, and there are ~29 unattributable `priority:"next"` occurrences.
  `MONITOR_TOOL` does not appear as a literal at all.

So: the conclusion (**background-command notifications are `'next'`**) is
supported, but by the Monitor literals rather than by reading the ternary's
resolved value. Anyone re-checking should use the first bullet.

**Upstream citations are local-only.** `vendor/claude-code-src/` is gitignored
(`.gitignore:64`) and is not present in a fresh clone, so every
`messageQueueManager.ts:129` / `LocalShellTask.tsx:169` / `query.ts:1642`
reference here and in `catalog.md` can be verified only by someone who has
fetched that source themselves, at a comparable version. Quoted line numbers are
against the snapshot present while this was written; treat them as a pointer to
the function, not a stable address.

So `<task-notification>` maps to **both** buckets, split by producer, and the
split is exactly *background command* (next) versus *agent/workflow* (later).
Both are distinguishable from content: `BACKGROUND_BASH_SUMMARY_PREFIX =
'Background command '` and the `Monitor "` prefix.

### 3.2 The failing sequence

Queue holds `[Agent "…" finished (later), Background command "…" completed (next)]`.

- **Claude** runs the mid-turn drain at threshold `next`: only the background
  notification is eligible. One `remove` record.
- **Agent Code** sees one `remove`, scores *both* items `later` (2), ties, and
  takes index 0 — the **agent** notification.

The agent notification is wrongly dropped and **the background command is
stranded permanently.** That is the bug, verbatim, and it explains the
divergence observed in real sessions (§4).

### 3.3 `remove` has versioned operation identity and a durable carrier

`remove` comes from exactly two callers, both now identified — the earlier
"who else calls remove" gap is closed:

- `query.ts:1642` `removeFromQueue(consumedCommands)` — **the dominant path.**
  Mid-turn, Claude snapshots `getCommandsByMaxPriority(sleepRan ? 'later' : 'next')`,
  drops slash commands, applies thread scoping, keeps `mode ∈ {prompt,
  task-notification}`, sends them to the model **as attachments**, then removes
  them, logging one `remove` per item.
- `REPL.tsx:2532` `removeByFilter(cmd => cmd.mode === 'task-notification')` —
  Ctrl+B session backgrounding.

Newer Claude writes the removed command in `remove.content`. Older Claude omits
that field but writes the mid-turn carrier as a durable
`attachment/queued_command`. The June rendering bundle records the legacy
ordering directly:

```
7:  queue-operation/enqueue  <prompt>
8:  queue-operation/remove           <- legacy, no content
13: attachment/queued_command         <- same prompt, stable UUID + timestamp
```

The reduced queue fixtures intentionally omit attachments, so their historical
`remove-is-not-persisted` slug describes that reduced schema, not Claude's
actual JSONL.

### 3.4 `popAll` is unhandled, and nothing repairs drift

`popAllEditable` pulls every *editable* command into the input box and
**deliberately leaves task-notifications queued**; it logs `popAll` **with
content**. `useIpcSubscriptions.ts:1495-1533` handles only
`enqueue`/`dequeue`/`remove` and falls through. Rare (1 record) but free to fix,
because the content is right there.

And nothing ever heals a mistake: `shouldClearIdleQueuedMessages` is
capability-gated on `usesOptimisticUserEcho`, which is `false` for Claude
(`registry.renderer.capabilities.ts:272`), and `queuedMessages` resets only on
session exit (`useIpcSubscriptions.ts:765`). **One mis-attribution is permanent
for the life of the session.** That is why it is *forever* rather than *briefly
wrong*.

### 3.5 Not a Codex bug

Codex has no `<task-notification>` grammar
(`providers/codex/renderer/components/native-spawn/index.tsx:17`), no queue
records, and its rows *are* covered by the idle-clear invariant. Structurally
immune. No Codex work here.

---

## 4. Reproduction on real data

Replaying the original reconstruction over its historical 220-session snapshot:
10 end holding a
non-empty queue, several holding a set **disjoint** from Claude's — the §3.2
signature exactly:

```
…/agent-code/80473d26-….jsonl   (enqueue=166 dequeue=91 remove=73)
  strip holds:  Background command "Poll v1.1.0 release run" completed
                Background command "Set qualification var + re-dispatch pass 2" completed
  Claude holds: Agent "Map workflow-mcp agent onboarding" finished
                Agent "Map Ink real-time update gaps" finished
```

Stranded background commands, dropped agent notifications. These sessions become
named fixtures in Stage 1.

---

## 5. The algorithm

Replay **runs** (maximal consecutive same-op records — one upstream call), not
individual records, against a queue of `{content, timestamp, mode, priority}`.

```
derivePriority(content):
  not <task-notification>            -> next          // enqueue() default
  summary starts 'Background command '-> next          // LocalShellTask, MONITOR_TOOL on
  summary starts 'Monitor "'          -> next
  no <status> tag                     -> next          // stall watchdog
  otherwise                           -> later         // agent / workflow / framework

eligible(item) = item.mode ∈ {prompt, task-notification} ∧ ¬isSlashCommand(item)

on ENQUEUE run:  append each, with derived mode+priority
on POPALL  run:  remove by logged content            reason: popped-to-composer
on DEQUEUE run of N:
     1. identity pass — for each committed user entry not yet consumed, remove
        the queued item it matches (task-id for notifications, normalized-prefix
        text for prompts)          reason: delivered-observed   evidence: entry uuid
     2. any shortfall of the N: take from eligible items ordered by
        (priority, insertion)      reason: delivered-inferred
on REMOVE run of N:
     1. when remove.content exists, remove its exact prompt/task identity
                                    reason: consumed-observed
     2. otherwise retain bounded count-only debt; a later queued-command
        attachment removes its exact pending identity
                                    reason: consumed-observed
     3. at the next non-remove operation or idle boundary, settle any shortfall
        by the safe cohort fallback  reason: consumed-inferred
```

**Why ordering by `(priority, insertion)` and taking N reproduces upstream
without needing to detect `Sleep`:** the mid-turn threshold is `next` normally
and `later` when the turn ran Sleep. Taking N in priority order naturally spills
into the `later` bucket exactly when N exceeds the `next` cohort — which is the
only situation in which upstream would have raised the threshold. The run length
is the authority for *how many*; the cohort rule is the authority for *which*.

**Why runs and not records:** upstream loops `logOperation` once per item inside
one logical call. Merging two genuinely separate single-item ops into one run is
harmless — take-first-1 twice equals take-first-2 under the same ordering — so no
timestamp heuristic is needed.

**Identity first, inference second.** Exact remove content and durable attachment
identity both outrank cohort selection. Only the shortfall is inferred, and it
is *recorded as inferred* so the next incident is diagnosable.

### Residue

After all of the above, the unattributable remainder is ~3% of notifications,
concentrated in 9 of 216 sessions (max 7 per session) — chiefly
`clearCommandQueue()`, which empties the queue and **logs nothing**
(`useCancelRequest.ts:249`, ctrl+x ctrl+k). No evidence exists for it, so it
cannot be attributed. It gets a **visible stale marker**, not deletion — see
§6.2.

---

## 6. Decisions — made, with reasoning

These were previously open questions. Answering them was my job; here are the
calls and why. Each is cheap to reverse.

### 6.1 Fixtures and one test file — yes, committed

The standing rule is no new committed test files in a feature PR. I am taking the
carve-out, because this PR rewrites an **ownership** decision, and the rendering
doctrine mandates fixture-first exactly here: *"you cannot fix a rendering bug by
reading code and editing it."* Shipping a rewrite of queue ownership with zero
recorded evidence is how the 2026-07-07 fix produced this bug. Scope held to the
minimum: `testing/fixtures/queue-operations/` plus **one** colocated
`claudeQueue/reconcile.test.ts`. Veto and I will convert it to `TEST-SITE:`
comments, but I would be shipping it blind.

### 6.2 Undecidable residue — mark stale, never delete

Show it, marked. Silent deletion is the irreversible #159/#290 class, and the
residue is ~3%. But a lingering *queue* row is a false claim about pending work,
so plain P6 "bias toward surviving" does not transfer unmodified — the row stays
visible and is labelled, which satisfies both. Trigger: the session is idle
(`streamPhase: 'idle'`, no process, not awaiting) **and** at least one departure
run has arrived since the item was enqueued without attributing it.

*Rejected alternative:* reading Claude's own on-screen queue preview as the
authority. `PromptInputQueuedCommands` hides task-notifications entirely
(`isQueuedCommandVisible` is `false` for that mode), so the screen can confirm
prompts but is blind to exactly the items in the bug report.

### 6.3 Keep showing task-notifications in the strip

Hiding them would match upstream and make the symptom vanish cheaply — but it is
the wrong trade. The reconstruction is *also* wrong for prompts (§3.2 drops a
real queued prompt on every mixed-cohort drain), so the substrate work is
required either way; and surfacing background-task state is a deliberate Agent
Code advantage over the upstream inbox. Fix the substrate, keep the surface.

---

## 7. Stages

### Stage 1 — Corpus + catalog

| | |
|---|---|
| **Produces** | `testing/fixtures/queue-operations/<session>.json` — redacted op runs plus the session's committed `user` entries. `catalog.md`: op vocabulary, run-lengths, the §3.1 priority table with its evidence, and the per-op observability split. |
| **Verified by** | Re-running the extractor is byte-identical; the redaction gate refuses to emit rather than warn; counts match an independent `jq` cross-check. |
| **Why separate** | The case set was assumed twice and wrong twice (batching is a minority; `remove` outnumbers `dequeue`). Built after the implementation, a catalog can only ratify it. |
| **Reality check** | 1915 transcripts, of which 220 carry queue ops. |

- [x] 1.1 `scripts/extract-queue-operations.mjs`, modelled on the hard-gated
      redactor in `scripts/extract-rendering-*`.
- [x] 1.2 Emit op runs **and** committed user entries in one artifact — Stage 3
      needs both halves.
- [x] 1.3 Promote the §4 divergence sessions (`80473d26`, `678676d3`,
      `00d4af94`) and the single `popAll` session as named fixtures.
- [x] 1.4 Write `catalog.md`, including the priority table and its provenance
      (source line + resolved-binary confirmation).

### Stage 2 — The reconciler (isolated)

| | |
|---|---|
| **Produces** | `src/renderer/src/session-runtime/claudeQueue/` — `types.ts`, `priority.ts`, `reconcile.ts`, `index.ts`. Pure: no React, no IPC, no feed imports. |
| **Verified by** | Tests written **first** against Stage 1 fixtures, asserting *which item left and why*, never queue length. |
| **Why separate** | Today three places decide queue membership — a helper, a live IPC branch, and an invariant that opts Claude out — and none records why. That is the distributed-ownership shape `rendering-design-principles.md` exists to prevent. |
| **Reality check** | Stage 1 artifacts. |

- [x] 2.1 `QueueDecision = { item, action, reason, evidence[] }` with `reason` a
      **closed enum**: `delivered-observed`, `delivered-inferred`,
      `consumed-observed`, `consumed-inferred`, `popped-to-composer`,
      `stale-unattributed`.
      New reason ⇒ new fixture, mirroring `RenderReason` discipline.
- [x] 2.2 `derivePriority` + `deriveMode` per §3.1, each row carrying a comment
      naming its upstream emit site.
- [x] 2.3 Failing tests from fixtures **before** the implementation. Must include
      the §3.2 sequence: `[Agent finished (later), Background command (next)]` +
      one `remove` ⇒ the **background** item leaves, the agent item stays.
- [x] 2.4 Implement run-grouping, the identity pass, and the cohort fallback.
- [x] 2.5 Reference stability: unchanged input returns the previous array by
      reference (D11 — a violation busts every `QueueStrip` memo).

### Stage 3 — Cutover

- [x] 3.1 Route `useIpcSubscriptions.ts:1495` through the reconciler; handle
      `popAll`.
- [x] 3.2 **Delete** `claudeQueueReconstruction.ts` and its test. Leaving it as a
      fallback is how the old model reasserts itself.
- [x] 3.3 Update the `queueInvariants.ts` comment — it justifies Claude's
      idle-clear exclusion by pointing at a reconstruction that will be gone.
- [x] 3.4 Re-run bundle + recording corpora. Triage every divergence in writing;
      **never** `AGENT_CODE_CORPUS_BLESS=1` to make red go green.
- [x] 3.5 `npm run typecheck` **plus raw `tsc` on both projects** — electron-vite
      and vitest do not type-check.

### Stage 4 — Stale marking

- [x] 4.1 Emit `stale-unattributed` per §6.2.
- [x] 4.2 `QueueStrip` renders the marker. It renders; it does not decide.
- [x] 4.3 Surface `decisions[]` in the debug-bundle capture so the next incident
      is diagnosed from the record, not re-derived from upstream source.

### Stage 5 — Adjacent fix (same surface, confirmed)

- [x] 5.1 `startStallWatchdog` emits a notification with **no `<status>`** for a
      command *blocked on an interactive prompt*. `taskNotificationStatusKind`
      returns `'other'` and `QueueStrip` renders `kind === 'error' ? '✗' : '✓'` —
      a stuck command shows a green check. Add a third state; do not overload ✓.

---

## 8. Isolation contract

**Lives in** `src/renderer/src/session-runtime/claudeQueue/`.
**Single consumer:** `useIpcSubscriptions`.

Forbidden after Stage 3:

- No component computes queue membership. `QueueStrip` renders what it is given.
- No second "why is this still queued" derivation — `decisions[]` is the
  diagnosis (principle P4).
- Nothing imports `applyClaudeQueueDequeue`; it will not exist.
- The module imports no `features/feed/**` and no provider renderer code.

---

## 9. What the review changed

Two independent reviewers ran against the first implementation. Four findings
were real and are fixed; recorded here because each was a case where the design
was right and the implementation quietly was not.

1. **`remove` has two callers with different selection rules, and only one was
   modelled.** `query.ts:1642` selects by priority; `REPL.tsx:2532` (Ctrl+B)
   selects by **mode** and removes task-notifications *only*. Taking the
   priority winner meant that on Ctrl+B with `[prompt, Agent finished]` we
   deleted the **prompt** — reintroducing both halves of the original bug
   inside the fix. The record cannot say which caller fired, so the tie now
   resolves toward the notification: wrongly removing one leaves a prompt
   visible and still retirable by the identity pass, while wrongly removing a
   prompt is irreversible.
2. **The reconciler state was written inside a React state updater.** Purity
   does not make that safe — React re-invokes updaters (StrictMode in dev, the
   eager-state path in prod), and the map was both the input and the output, so
   pass 2 read pass 1's write. One `dequeue` burst became `debt.count = 2` and
   retired an item that was never delivered, labelled `delivered-inferred`.
   Both call sites now capture a candidate and commit after `setRuntimes`
   returns.
3. **`staleChanged` compared against a possibly-absent map key.** A fresh
   Claude session took `markStaleWhenIdle(create())` and compared it to
   `undefined`, reading as "changed" on every idle event: it wiped
   `queuedMessages` and defeated the no-op bail. It now only marks an existing
   reconciler state.
4. **`<result>` bodies survived capping.** Fixture capping truncates the
   closing tag, so the strip regex missed 139 partial subagent reports. Both
   the terminated and truncated forms are handled.

The corpus was also rebuilt under stricter publication rules — agent-code
sessions only, prompt prose pseudonymized, `<result>` bodies dropped. See
`testing/fixtures/queue-operations/catalog.md`.

## 10. Residual risk

- **Upstream version drift.** The priority table is read from a vendored snapshot
  plus the resolved 2.1.220 binary; `support/upstream-versions.json` accepts
  2.1.143. If Anthropic moves every task type to `'next'` (the `query.ts` comment
  says "if all task types move to 'next', this branch could go"), `derivePriority`
  collapses to a constant and the identity pass carries the load unchanged. The
  design degrades safely; the table is one file.
- **`agentId` scoping is not modelled.** The queue is a process-global shared by
  the coordinator and in-process subagents; each drains only its own scope
  (`query.ts` comment). The op record carries no `agentId`, so this is not
  recoverable from the log. Effect is bounded: subagent-scoped notifications may
  linger and will surface as `stale-unattributed` rather than as a wrong
  deletion. Documented, not silently ignored.
- **Legacy evidence can cross watcher bursts.** Remove debt therefore retains
  only a bounded count across bursts and settles at a later operation/idle
  boundary. It never retains copied prompt content; unmatched fallback is
  recorded as `consumed-inferred`, never as proof.
