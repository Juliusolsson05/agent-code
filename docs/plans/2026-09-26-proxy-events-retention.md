# Bound a live Claude session's proxy-events.jsonl (#1273 residual)

## Problem

#1284 / claude-code-headless#62 stopped writing request bodies past 256 MiB per events file. What the
issue still has open:

1. The file is still unbounded. Responses, stream chunks and body-less request records keep
   appending — about 7 % of the old byte rate, ~170 MB per 2.4 GB of old-rate traffic — for as long
   as the session lives.
2. A live file is never reclaimed: `debugRetention.ts` skips any run written in the last 10 minutes
   (`ACTIVE_GRACE_MS`), and a session that stays open for days keeps its file "live" all that time.

## Evidence

- Composition of a real post-#62 events file (owner's machine, run
  `…/resume-fa48baff…/2026-09-25T17-34-30-657Z`): `request` lines 98.1 % (bodies until the budget),
  `response-chunk` 1.7 %, `response` 0.2 %. Past the budget, chunks/responses/body-less requests are
  what keeps growing.
- The file is not just a log: it is the **transport** from mitmdump to the app. `ProxyServer`
  polls it every 200 ms from a byte offset and emits each complete line as a live event; the
  adapter builds the transcript view from the `response-chunk` lines. So "stop writing chunks past a
  budget" would break the live view, and truncating in place would drop or duplicate events.

## Decisions (defaults)

- **Rotate in the addon, keep one previous generation.** When the events file reaches
  `PROXY_EVENTS_ROTATE_BYTES` (default 512 MiB), the addon renames it to `proxy-events.1.jsonl`
  (atomically replacing the older generation) and the next write starts a fresh
  `proxy-events.jsonl`. A live run therefore holds at most ~2 × 512 MiB (+ the 16 MiB latest-body
  sidecar), instead of growing for the life of the session. Rotation failure is non-fatal: the addon
  keeps appending (forensics must never disturb the proxy).
  - WHY 512 MiB and one generation: the body budget (256 MiB) still applies per file, so each
    generation keeps ~100 turns of bodies plus a long stretch of body-less traffic; the debug bundle
    only ever ships the last 5 MiB. Deleting generation 2 is the point of the change.
  - WHY rotate on the writer side: mitmdump is the single writer, runs single-threaded, and writes
    each line with open-append-close, so after `os.replace` no write can land in the old inode.
    Rotating from the app would race the writer.
- **The tail holds the generation it reads open** (revised after review of claude-code-headless#64,
  steering q53).
  - The first version stat()ed the path and later open()ed it by name. A rotation between the two made
    it read the new file with the old offset; reviewers reproduced lost and duplicated events.
  - `EventsFileTail` now keeps a `FileHandle` on the current generation. Its size comes from `fstat` on
    that handle, and rotation is detected when the *path's* inode changes.
  - On rotation, the tail finishes the held generation, **opens the live file first**, and then reads
    whole any unseen generation at `.1` before the live one. Anything between the two held handles can
    only be at `.1`.
  - Pinned by a test that rotates before every path-level await point.
- **Gap policy: a bounded, reported gap, not an acknowledgement protocol** (q53 asked us to choose).
  - The addon bumps `proxy-events.rotations` before each rename.
  - When the poller stalls through more rotations than it can hold or drain (about 1 GiB of traffic at
    the default), the generations deleted unread are counted as `lostGenerations`. `ProxyServer`
    surfaces them as a `transport-gap` event plus one warning. The claim is "exactly once, or an
    explicit gap".
  - An ack protocol would need a second writer in the app. A stalled or dead app would then let the
    proxy's disk grow without bound again, which is this issue.
- **Addon hardening** (same review):
  - `_write` never raises out of a mitmproxy hook, since the stream tap carries the user's live
    response;
  - a crashed partial line is terminated at startup, so the next event is not glued to it;
  - the live file is recreated in its own step.
- **Debug bundle reader: owned by W1 in #1332** (steering q54). This branch's own `readEventsTail`
  change was reverted (`0a462fad`). #1332 makes one provider-neutral, rotation-safe reader: one
  handle, `bytesRead` honoured, filling from `.1`. This branch merges main after #1332 and keeps only
  Claude-specific wiring, if any is still needed.
- **Retention unchanged.** With rotation, a live run is bounded, so the 10-minute grace no longer
  lets one session fill the disk; old oversized files from before this change age out normally.

## Tests

- Package, real addon + real tailer (see the PR body for the final list, incl. the per-await-point
  rotation cases and the ProxyServer wiring test): drive the real `mitmAddon.py` (`request` / `response` /
  chunk hooks, a small `PROXY_EVENTS_ROTATE_BYTES`) through several rotations while an
  `EventsFileTail` polls between writes; assert every event is emitted exactly once and in order,
  only one previous generation exists, and the live file stays under the threshold + one line.
  Fail-first: without rotation the file exceeds the bound; without the poller's rotation handling,
  events written between the last poll and the rename are lost (asserted by name).
- Poll ordering: rename observed while the new file is still absent, and a rotation that happens
  while the old generation ended mid-poll — both orders pinned.
- App: none on this branch; the bundle reader's tests live in W1's #1332 (q54).

## Delivery

claude-code-headless#64 (addon + tailer), three reviews plus verification, then the agent-code PR
bumping the pointer (lockfile resync for the `file:` dep) with this plan, after #1332 merges.
`Fixes #1273` goes on the agent-code PR only if both residual items are covered.
