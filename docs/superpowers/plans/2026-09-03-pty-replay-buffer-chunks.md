# Main: make the PTY replay buffers amortised O(chunk)

Fixes #726. Refs #390, #321, #103, #327.

## Problem

`SessionManager` keeps two per-session replay buffers as plain strings —
`terminalBuffers` (256 KiB cap) and `agentPtyBuffers` (512 KiB cap) — and
appends with `appendCappedBuffer`: `prev + data`, a `charCodeAt` that
flattens the concat into a fresh (cap + chunk) copy, then `slice`, whose
result is a V8 SlicedString that keeps that whole flattened parent alive.
Once a buffer is full (minutes into any agent session), every chunk from
every session copies the whole cap on the main thread and the stored value
retains cap + chunk. A chunk larger than the cap is retained in full: the
2026-09-03 heap snapshot holds six identical 1.8 MB docker-build repaints
and ~10 identical 1 MB Claude screen frames for exactly this reason.

## Design

Replace the string with a small `CappedTextBuffer` (new module under
`src/main/sessions/`): a list of chunks plus a running length.

- `append(chunk)` pushes the chunk and drops whole oldest chunks while the
  total exceeds the cap — amortised O(chunk), no copy of the retained
  bytes. Dropping whole chunks can never split a surrogate pair, which is
  why the old code needed its low-surrogate check.
- A chunk larger than the cap on its own replaces the whole buffer with a
  real copy of its tail (surrogate-safe cut, forced flat so the oversized
  chunk is released — the #321 lesson).
- `read()` joins once. It runs only on attach, which is rare, so the join
  is the right place to pay the O(cap) cost.
- `length` is exposed for tests and diagnostics.

`SessionManager` swaps the two `Map<string, string>` for
`Map<string, CappedTextBuffer>`; the attach/replay contract (bytes
accumulate from process start, attach returns the current tail in the same
synchronous block that flips the attached flag, caps unchanged) does not
move.

## Verification

- New `cappedTextBuffer.test.ts`: retains the newest bytes under the cap,
  never exceeds the cap, keeps whole chunks, handles an oversized chunk by
  keeping a surrogate-safe tail that is not a slice of the input, and
  `read()` reflects appends in order.
- `npx tsc -p tsconfig.node.json --noEmit`.
- Existing SessionManager suites.
- After: main `eventLoop.meanMs` and GC pressure during heavy multi-session
  output should drop; no session should retain more than its cap.
