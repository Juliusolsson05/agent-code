# The "prompt stuck in queue" bug — root cause, fix design, regression lock

Research date: 2026-07-07. Scope: the RUNTIME half of the queue bug ("a queued message never
becomes a user message"), not feed rendering. Evidence: three manual debug bundles + on-disk
Codex rollout files + code in `src/renderer/src/workspace/`, `src/main/`, and the
`packages/{codex,claude-code}-headless` submodules + a live Node repro of the kill mechanism.

---

## TL;DR

The queue never "fails to dispatch" — **the prompt reaches the model every time** (PTY write
succeeds; the proxy records a new turn ~2–3s after submit in all three bundles). What dies is
the **committed rollout JSONL tail**: after a pane resume through `replaceSession`, the OLD
session's `FileTailer.close()` calls Node's `unwatchFile(path)` **without a listener argument**,
which removes **ALL** stat-watchers for that path in the process — including the one the NEW
session just registered on the very same rollout file. From that moment the renderer never
ingests another committed entry. Because the committed user row never arrives:

1. the queued placeholder row is never reconciled away (`useIpcSubscriptions.ts:1523`),
2. the prompt never renders as a real user message, and
3. `shouldQueueOptimisticCodexUserEntry` returns `true` for **every subsequent submit** (its
   "completed semantic history still renderable" branch stays true forever because committed
   text never takes ownership) — so every follow-up prompt also lands in the queue chip.

The spawn→kill ordering in `replaceSession` makes this **deterministic, not a race**: the new
tailer's `watchFile` is always registered before the old session's `killSession` runs
`unwatchFile`. That is why the bug is "haunting again and again" — every in-place
resume/reload of a long-lived Codex pane reproduces it 100% of the time.

---

## 1. Evidence from the bundles

All three bundles are **Codex** sessions (`manifest.json "kind": "codex"`), resumed panes
(proxy run dirs `resume-019ef574-…` and `resume-019eeec5-…`).

### Shared snapshot signature (state-snapshot.json)

| field | 06-24 14:52 (75fb2add) | 06-24 19:13 (75fb2add) | 06-22 11:53 (3398cdb4) |
|---|---|---|---|
| `queuedMessages[0].timestamp` | `1782312716779` | `1782328380038` | `1782129190752` |
| `submittedAt` | `1782312716779` | `1782328380037` | `1782129190751` |
| `streamPhase` | `requesting` | `responding` | `thinking` |
| `sessionStatus` / `processStatus` | `running` / `started` | `running` / `started` | `running` / `started` |
| `inputReady` | `true` | `true` | `true` |
| `awaitingAssistant` | `false` | `false` | `false` |
| `lastJsonlEntryAt` | `1782307419496` (13:23:39Z — **88 min before submit**) | `1782326068452` (18:34:28Z — 39 min before) | `1782128769873` (11:46:09Z — 7 min before) |

Key reading: queue timestamp == submittedAt +1ms → the submit path itself enqueued the
placeholder (`addOptimisticCodexUserEntry` queue branch), the turn started normally
(`streamPhase` active, `phaseChangedAt` = submit +3–4s), but **`lastJsonlEntryAt` is frozen far
in the past** — the committed channel is dead.

### feed-debug.jsonl, bundle 1 (the smoking gun)

```
14:49:25.807 STATE session_started
14:49:25.963 JSONL jsonl_entries        | entries +97          ← resume bootstrap (tail-lines read)
14:49:32.036 STATE optimistic_user_add  | "Good, now come the tricky part…"   ← 1st submit: normal row
14:50:08     SEM   text_delta …          ← full turn streams + completes via PROXY semantics
14:51:56.779 STATE submit
14:51:56.779 STATE optimistic_user_queue| "That is great, so my question…"    ← 2nd submit: QUEUED
14:51:59.434 SEM   turn_started src=proxy turn=resp_02d1a      ← the "stuck" prompt DID dispatch
```

**Zero `JSONL` layer events after the bootstrap at 14:49:25.963.** Not "entries +0" — the log
site (`useIpcSubscriptions.ts:1728`) fires even for side-effect-only bursts, so absence proves
no burst reached the renderer at all.

### The rollout file on disk proves Codex wrote everything

`~/.codex/sessions/2026/06/23/rollout-2026-06-23T19-08-38-019ef574-953a-7990-a85e-36219ee37cad.jsonl`
(the exact file for the resumed thread `019ef574`, i.e. the file the resume lookup finds):

```
line 3584  2026-06-24T13:23:39.496Z  user row  "Good, now come th…"   ← == lastJsonlEntryAt in bundle 1
line 3588  2026-06-24T14:49:32.095Z  user row  "Good, now come th…"   ← 1st submit, 7s after attach — NEVER ingested
line 3609  2026-06-24T14:51:56.791Z  user row  "That is great, so…"   ← the "stuck" prompt, 12ms after submit — NEVER ingested
line 5400  2026-06-24T19:13:00.651Z  user row  "foix what you thi…"   ← bundle-2 stuck prompt — NEVER ingested
```

Bundle 3's stuck prompt is likewise present in
`22/rollout-2026-06-22T11-59-44-019eeec5-8c1f-….jsonl`. So: right file, rows written within
milliseconds, tailer attached to that very path (bootstrap proves it) — and the incremental
watcher never fired again. Poll interval is 100ms; 7 seconds of silence on the first post-attach
append means the watcher was **dead from birth** of the new pane.

Bundle 3 nuance: its `lastJsonlEntryAt` (11:46:09) is *after* its 10:23:59 resume — that pane
was healthy at first (spawned via a kill-first path, e.g. app-boot rehydrate) and died at a
later in-place reload ~11:47–11:52 whose bootstrap newest entry was 11:46:09. Same terminal
state, same mechanism.

---

## 2. The kill mechanism (verified by repro)

`packages/codex-headless/src/transcript/JsonlTailer.ts:237-241` (identical in
`packages/claude-code-headless/src/transcript/JsonlTailer.ts:254-258`):

```ts
async close(): Promise<void> {
  this.closed = true
  unwatchFile(this.filePath)      // ← NO listener argument
}
```

Node semantics: `fs.unwatchFile(filename)` without a listener **removes all listeners** for the
path and stops the shared per-path StatWatcher. Verified with a standalone repro
(scratchpad/unwatch-repro.mjs): two `watchFile` registrations on one path; after
`unwatchFile(path)` from "tailer A", tailer B never fires again:

```
before close A: { aFired: 1, bFired: 1 }
after close A + append: { aFired: 1, bFired: 1 }   ← B is dead
```

### Why two tailers share a path: replaceSession's spawn-before-kill

`src/renderer/src/workspace/hook/actions/session.ts` (replaceSession — per its own comment,
"Reload, provider switch, resume, and rewind all funnel through this path"):

```ts
const newId = await spawn(cwd, { ...spawnOpts })   // :628  NEW session up first (registers watchFile
                                                   //        on rollout-…<threadId>.jsonl during
                                                   //        CodexHeadless.start → tailFile)
...
await window.api.killSession(oldId)                // :640  THEN old session dies:
                                                   //        stop → cleanup → stopRolloutTail →
                                                   //        FileTailer.close → unwatchFile(path)
                                                   //        → kills the NEW watcher too
```

Old and new sessions tail the SAME file whenever the pane is resumed onto the same Codex thread
(the overwhelmingly common "reload this conversation" case). `spawn()` resolves only after
`CodexHeadless.start()` has registered `watchFile`, so `unwatchFile` **always** lands after it.
Deterministic kill, not a race.

Bootstrap still "works" because `bootstrapTail()` is a synchronous read in the FileTailer
constructor — hence the misleading "+97 entries then silence" signature.

Note: `reloadAgentSessions` (session.ts:787→804) kills first, then spawns — safe ordering. Only
the replaceSession family is affected, which matches the bundles (resume picker / in-place
reload panes).

### Downstream: why a dead tail turns into "stuck in queue"

- `addOptimisticCodexUserEntry` (`hook/actions/streaming.ts:172-226`): a submit goes to
  `queuedMessages` instead of an optimistic feed row when
  `shouldQueueOptimisticCodexUserEntry` is true. Its second branch (streaming.ts:73-82, the
  #239 fix) returns true while any completed semantic turn is still "renderable", where
  renderability is defeated only by committed assistant text
  (`buildCommittedAssistantText(current.entries)`). Dead tail ⇒ committed entries never grow ⇒
  branch stays true forever ⇒ **every** submit after the first completed turn is queued.
- Queue exit paths:
  1. committed user row match (`useIpcSubscriptions.ts:1523-1539`) — requires the dead
     committed channel; never fires.
  2. `shouldClearIdleQueuedMessages` (queueInvariants.ts, edge sites at
     useIpcSubscriptions.ts:788/1014 + idle-reconcile backstop :406) — requires
     `streamPhase === 'idle' && !processActive`; false while the turn runs, and when it
     eventually fires it **deletes** the row. The prompt vanishes without ever becoming a user
     message — exactly the note: "propmt stuck in queue and does not make it to a user message."
- Meanwhile the turn itself runs fine via PTY + proxy semantics, so the assistant *answers* a
  prompt the feed never shows — maximally confusing.

Claude panes share the same tailer bug (same class, same `unwatchFile`); there the dead tail
freezes the whole committed transcript (user rows, queue-operation enqueue/dequeue records,
tool results), which is plausibly the Claude-flavored sightings of the same haunting.

---

## 3. Fix design

### 3a. The actual fix — scoped unwatch (both headless submodules)

`packages/codex-headless/src/transcript/JsonlTailer.ts` and
`packages/claude-code-headless/src/transcript/JsonlTailer.ts` (separate repos:
Juliusolsson05/codex-headless, Juliusolsson05/claude-code-headless; one PR each + submodule
pointer bumps in agent-code):

```ts
// store the listener so close() can unsubscribe ONLY itself
private readonly statListener = (curr: Stats, prev: Stats): void => { …existing body… }

constructor(…) {
  …
  watchFile(filePath, { interval: POLL_INTERVAL_MS, persistent: true }, this.statListener)
}

async close(): Promise<void> {
  this.closed = true
  unwatchFile(this.filePath, this.statListener)   // scoped: sibling tailers survive
}
```

Thick WHY comment to add at the close site: `unwatchFile(path)` without a listener removes ALL
watchers for the path process-wide; replaceSession spawns the successor pane before killing the
predecessor, so both tail the same rollout/JSONL during the handoff and an unscoped unwatch
deterministically kills the successor's committed channel (the 2026-06-24 stuck-queue bundles).

While in there (same PR, blast radius): `stream.on('error')` in `readNew()` resets `reading`
but never drains `pendingRead`; drain it like the `end` handler does. Harmless today (next poll
re-triggers) but it is the only other way the tailer can go quiet.

### 3b. Self-healing + observability — tail-stall watchdog (both submodules)

The unwatch fix removes the known killer, but the class of failure ("file grows, tailer
silent") deserves a backstop that makes the next occurrence self-diagnosing AND self-repairing.
In FileTailer: a low-frequency interval (e.g. 15s) that stats the file; if
`size > offset` persists across two consecutive ticks with no emit in between, (1) emit a
diagnostic through `onError`-adjacent channel — for codex-headless surface it as the existing
`rollout-diagnostic` event (`type: 'tail-stalled'`, with `{ file, offset, size, lastEmitAt }`),
(2) re-arm: `unwatchFile(path, listener)` + `watchFile(...)` + `readNew()`. This converts any
future watcher death into a ≤30s hiccup with a bundle-visible breadcrumb instead of a permanent
silent outage.

### 3c. Queue-decision log — make the next bundle one-glance diagnosable (agent-code)

- `src/renderer/src/workspace/hook/actions/streaming.ts` — the `optimistic_user_queue`
  feed-debug entry already logs `streamPhase` and `activeSemanticTurn`; add the two fields that
  would have named this bug instantly:
  - `committedTailAgeMs: now - (current.lastJsonlEntryAt ?? 0)` — a large value at queue time
    (88 minutes in bundle 1) is the smoking gun for a dead committed channel;
  - `queueReason: 'live-semantic-turn' | 'completed-history-renderable'` — split
    `shouldQueueOptimisticCodexUserEntry` so the caller knows WHICH branch queued (return a
    reason, not a boolean). The completed-history branch firing on a visibly idle pane =
    committed starvation.
- `src/main/sessionManager.ts` + `src/renderer/src/features/debug/saveDebugBundle.ts` — expose
  tail health in bundles: a `getTranscriptTailDiagnostics(sessionId)` IPC returning
  `{ file, tailOffset, fileSize, lastEmitAt, tailedPaths }` from the headless session (needs a
  tiny getter on CodexHeadless/ClaudeHeadless surfacing FileTailer state), included in
  `state-snapshot.json`. `fileSize > tailOffset` in a snapshot = dead tail, no rollout grep
  needed next time.

### 3d. Optional renderer resilience (separate follow-up, NOT required once 3a lands)

If we want the feed to degrade gracefully under any future committed-channel outage: when the
proxy semantic channel reports `turn_started` while `queuedMessages` is non-empty and no other
turn was live at submit, promote the head queued row to an optimistic user Entry (the
`optimistic_user_add` path) instead of leaving it in the queue lane. This keeps the user's
prompt visible even with a dead tail. Deliberately out of scope for the fix PR — it re-opens the
#239 ordering questions and 3a+3b already remove the trigger.

### What NOT to change

- `replaceSession`'s spawn-before-kill ordering is intentional (flicker-free pane swap,
  draft/runtime handoff). With a scoped unwatch the overlap is exactly the harmless
  double-tail-then-single-close it was assumed to be. Don't reorder it.
- `shouldQueueOptimisticCodexUserEntry`'s completed-history branch is correct given its inputs;
  the input (committed entries) was starved. Don't weaken the #239 fix.

## 4. Regression lock

Per repo policy, no new test files in the agent-code fix PR; the real tests live in the
submodule repos, which own the bug:

- **codex-headless + claude-code-headless** (their own suites): unit test on FileTailer /
  `tailSessionFile` — create a temp jsonl, open tailer A then tailer B on the SAME path, append
  (both emit), `await A.close()`, append again, assert **B still emits** (fails on the current
  code, passes with the scoped unwatch; my unwatch-repro.mjs is the skeleton). Second case:
  close B, assert A unaffected. If the 3b watchdog lands, one test: stub a dead watcher (call
  `unwatchFile(path)` externally), append, advance timers, assert re-arm + diagnostic emission.
- **agent-code**: the existing rendering/fixture harness already locks the composer-lane
  rendering half. For the runtime half the queue-reason split in 3c is pure-function refactor
  covered by the existing `queueInvariants` / streaming test surface if touched; verification
  gate is the usual raw `tsc` on node+web projects, plus an end-to-end manual: resume a codex
  pane in-place, submit twice mid-/post-turn, confirm the second prompt commits as a user row
  and the queue chip clears (this exact flow was 100%-reproducible before the fix, so it doubles
  as the verify step).

## 5. Rollout order

1. PR to codex-headless (3a + 3b + tailer unit test), PR to claude-code-headless (same).
2. agent-code PR: submodule pointer bumps + 3c observability (queue-reason + committedTailAgeMs
   + tail diagnostics in bundles).
3. Optional later: 3d promotion-on-turn-start.
