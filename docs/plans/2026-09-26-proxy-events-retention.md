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
- **The poller follows rotations (tail -F semantics).** It records the events file's inode. When the
  path's inode changes, it first drains the rotated generation (`proxy-events.1.jsonl`) from the
  saved offset to its end, then restarts at offset 0 on the new file. Result: every event is emitted
  exactly once, in order, across a rotation. The existing "file shrank ⇒ restart from 0" fallback
  stays for a recreated file whose inode we never saw.
  - The poll logic moves out of `ProxyServer` into a small `EventsFileTail` so it can be driven
    directly in tests (no mitmdump, no timers).
- **Debug bundle reads across the rotation.** `proxyEventsReader` (app) prepends the tail of
  `proxy-events.1.jsonl` when the current file is smaller than the 5 MiB bundle cap, so a bug report
  made right after a rotation still carries recent history.
- **Retention unchanged.** With rotation, a live run is bounded, so the 10-minute grace no longer
  lets one session fill the disk; old oversized files from before this change age out normally.

## Tests

- Package, real addon + real tailer: drive the real `mitmAddon.py` (`request` / `response` /
  chunk hooks, a small `PROXY_EVENTS_ROTATE_BYTES`) through several rotations while an
  `EventsFileTail` polls between writes; assert every event is emitted exactly once and in order,
  only one previous generation exists, and the live file stays under the threshold + one line.
  Fail-first: without rotation the file exceeds the bound; without the poller's rotation handling,
  events written between the last poll and the rename are lost (asserted by name).
- Poll ordering: rename observed while the new file is still absent, and a rotation that happens
  while the old generation ended mid-poll — both orders pinned.
- App: `proxyEventsReader` bundle test with a small current file + a previous generation.

## Delivery

claude-code-headless PR (addon + tailer), three reviews, then the agent-code PR bumping the pointer
(lockfile resync for the `file:` dep) with the `proxyEventsReader` change and this plan.
`Fixes #1273` goes on the agent-code PR only if both residual items are covered.
