# Claude queue-operation records get a stable per-record cursor (#675)

Status: EVIDENCE STAGE (staged decomposition). No reducer change until W4's #1364 (which edits `claudeQueue/reconcile.ts`) merges, so the two PRs never touch the same file at once.

## Problem (from #675)
Only `enqueue` is idempotent, via `(timestamp, content)`. A replayed content-free `remove` opens a second inference debt, and an exact enqueue/remove replay appends a second decision. Recorded `queue-operation` lines carry no uuid, so nothing in the RECORD can dedupe them. A transport-level cursor is needed.

## Evidence so far (claude-code-headless @ 64fd0ea)
- **`FileTailer.bootstrapTail(maxLines)`** re-emits the last N complete lines on EVERY construction. In that pass each line's byte position is known: `start + offset-in-buffer`. The live `readNew()` knows it too: `this.offset + offset-in-chunk`. So a per-line `(file generation, byteOffset)` cursor is free at the source.
- **`followClaudeTranscript`** (the resume path) constructs the tailer with `RESUME_BOOTSTRAP_TAIL_LINES = 200`. Every Claude resume, Reload Agents, provider switch or rewind therefore replays up to 200 recent lines, including any `queue-operation` records among them.
- **Codex already has this contract:** `AgentTranscriptObservationMetadata { fileGenerationId, rolloutByteOffset }` (`src/shared/types/session.ts`), emitted by codex-headless beside each `jsonl-entry` and already threaded through `useIpcSubscriptions` as `{ entry, observation }`. Claude simply never fills it. The provider-packages rule (siblings mirror each other 1:1) points at the same shape.

## Open questions (answer from recordings before designing)
1. Does the successor's renderer queue state start empty, or does it inherit the predecessor's pending items and applied decisions? If it starts empty, the 200-line replay REBUILDS the queue rather than duplicating it, and the harmful redelivery is narrower. Candidates: relocation mismatch re-bootstrap, the watchdog re-arm, main's JSONL coalescer on renderer reload.
2. Does the history loader also apply `queue-operation` records, so they overlap the bootstrap tail?
3. Recorded evidence: count `queue-operation` lines inside the last 200 lines of real `~/.claude/projects/*.jsonl` files at resume points. Look in the lifecycle journal for a duplicate remove debt.

## Shape if confirmed
- **Package:** `FileTailer` passes `{ fileGenerationId, byteOffset }` with every entry. The generation is minted per `(dev, ino)` and bumped on truncation or relocation mismatch. `ClaudeCodeHeadless` emits it beside `jsonl-entry`, exactly as codex-headless does.
- **App:** main forwards it (the observation sidecar already exists). `applyQueueOperation` takes the cursor and ignores a record whose cursor it already applied. The applied-cursor set is bounded, and is keyed per generation, so a legitimate batch of same-timestamp removes (distinct offsets) is never swallowed.

## Evidence-stage conclusion (2026-09-27)
No current path redelivers a record into the same live queue state:
- **Package:** relocation keeps the byte cursor, and a divergence errors instead of replaying.
- **Main:** the forwarder has no resend.
- **Renderer:** queue state is keyed by session id. A successor gets a fresh one, and a same-id respawn is preceded by `onSessionExit`, which deletes it. A reload clears the map. History never applies queue operations.

The 200-line resume replay therefore REBUILDS a new session's queue. Posted on #675 with a `needs-evidence` proposal. The shape above stays ready if a recording shows a duplicate remove debt.
