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
  `proxy-events.jsonl`. The **events file** therefore holds at most ~2 × 512 MiB instead of growing
  for the life of the session. The run directory is NOT fully bounded by this change: the latest-body
  sidecar is ~21.3 MiB on disk (16 MiB raw, base64; briefly twice that during its atomic replace), and
  `sslkeylog.log` still grows without bound (#1380). See the review outcome under Delivery. Rotation failure is non-fatal: the addon
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
  - Each generation created by a rotation carries its number in a header line, `{"kind":"generation","generation":n}`, created atomically with the live file. Generation 0 (the run's first file) has none; the tail reads a missing header as generation 0 and strips the line when present.
  - The bound holds under the default `PROXY_EVENTS_ROTATE_BYTES`; setting it to 0 (the forensic override) disables rotation.
  - This replaced a first design with a `proxy-events.rotations` counter file, which a reader could pair with the wrong generation (round 2 of #64).
  - When the poller stalls through more rotations than it can hold or drain (about 1 GiB of traffic at the default), the generations deleted unread are counted as `lostGenerations`. `ProxyServer` surfaces them as a `transport-gap` event plus one warning.
  - An ack protocol would need a second writer in the app. A stalled or dead app would then let the proxy's disk grow without bound again, which is this issue.
- **Known limitation** (accepted by the manager under the final-pass cap, stated in claude-code-headless#64):
  - A process crash between renaming the live file to `.1` and publishing the next header is repaired when the addon restarts (`2218918`).
  - If the addon is never restarted, the rotated generation's unread events are not delivered and **not** reported as a gap.
- **Addon hardening** (same review):
  - `_write` never raises out of a mitmproxy hook, since the stream tap carries the user's live
    response;
  - a crashed partial line is terminated at startup, so the next event is not glued to it;
  - the live file is recreated in its own step.
- **Debug bundle reader: owned by W1 in #1332** (steering q54). This branch's own `readEventsTail`
  change was reverted (`0a462fad`). #1332 makes one provider-neutral, rotation-safe reader: one
  handle, `bytesRead` honoured, filling from `.1`. This branch merges main after #1332 and keeps only
  Claude-specific wiring, if any is still needed.
- **Retention: one change.** Run detection now also counts a directory holding only
  `proxy-events.1.jsonl` (found in review). With rotation the events file is bounded, so the 10-minute
  grace no longer lets one session's events fill the disk (`sslkeylog.log` is #1380); old oversized
  files from before this change age out normally.

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
- App (added after the #1376 review): `claudeSession.suspension.test.ts` pins that both the `event`
  and `transport-gap` channels are forwarded and detached; `sessionManager.proxyGap.test.ts` pins the
  `claude.proxy_transport_gap` incident, its re-emit, and that a replaced session's late gap is
  ignored; `debugRetention.test.ts` pins that a run holding only `proxy-events.1.jsonl` is counted.
  The bundle reader's own tests live in W1's #1332 (q54).

## Delivery

claude-code-headless#64 (addon + tailer): three reviews, verification, and a final round 3, MERGED (`f52fc82`). This agent-code PR bumps the pointer and, after its review, adds the app-side
wiring below (gap forwarding and incident, `.1`-only retention); it `Refs #1273` rather than fixing it. #1332 (W1's rotation-safe bundle reader) is already on main.
- **No lockfile resync is needed.** The app consumes claude-code-headless from source (tsconfig and Vite aliases), not as a `file:` dependency, and its runtime dependencies (`chokidar`, `@xterm/headless`) are already root dependencies. The bump changes only the package's own devDependencies; `npm install --package-lock-only` leaves `package-lock.json` unchanged.
- **The generation header** is one more JSON line with an unknown `kind` to the app's only direct reader (the bundle reader, which ships raw bytes). The addon recreates `proxy-events.jsonl` immediately, so `debugRetention`'s run detection is unaffected.
- **Review of #1376 (a, b, c):**
  - **The app dropped the gap signal.** `ClaudeSession` subscribed to the proxy's `event` channel only, so `transport-gap` never left the package. It now subscribes to both (`attachProxyServer`/`detachProxyServer`) and re-emits `proxy-transport-gap`. `SessionManager` records a `claude.proxy_transport_gap` incident and re-emits it with the session id. This is diagnostic only (steering q87): no missing-span marker is rendered yet, so the user-visible gap is #1381. The normal `event` wiring is now pinned too; deleting it used to pass every test.
  - **A run holding only `proxy-events.1.jsonl` was invisible to retention.** `collectProxyRunDirs` now counts it.
  - **`sslkeylog.log` also grows without bound** in every live run directory, and holds TLS secrets. This is outside this bump, so it is filed as #1380. The PR says `Refs #1273`, not `Fixes`: the events file is bounded, but a live run directory is not fully bounded until #1380 lands.
  - **The latest-body sidecar** is ≤ 16 MiB raw, about 21.3 MiB on disk after base64 encoding. During the atomic replace, twice that is briefly possible.
