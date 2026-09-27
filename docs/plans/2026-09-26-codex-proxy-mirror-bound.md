# Codex proxy mirror: bounded on disk, off the synchronous path (#372)

Size: standard. The root cause is known, and there are real design choices: rotate or omit, and the queue policy.

## Outcome
A Codex session's `proxy-events.jsonl` mirror:
- never blocks the Electron main process on a synchronous file append;
- never exceeds a fixed on-disk size per run;
- always keeps the most recent traffic, which is what a debug bundle needs;
- says in the file itself when it dropped or rotated anything.

## Evidence (verified 2026-09-26, do not re-derive)
- **What is left of #372.** Only the Codex proxy mirror, as the issue's status says.
  - `feed-debug` already has a 128 MiB per-file cap with tombstones and drop counters (`src/main/storage/feedDebugLog.ts`, `MAX_FEED_DEBUG_FILE_BYTES`). The largest live file is 134,217,556 bytes, which is at that cap.
  - `~/.config/agent-code/performance` is empty, because #958 moved the performance logs to a bounded store.
- **Writer.** `packages/codex-headless/src/proxy/responsesProxy.ts`, `ResponsesProxy.emit`, runs `JSON.stringify` and then `appendFileSync` for every `event` emit, before the listeners run. There is no cap and no drop policy.
  - #53 (merged) fixed the Buffer replacer, so chunk lines are now base64 (about 1.37× the payload) instead of decimal arrays (3.7×).
  - The running app predates #53, so today's live files still hold the decimal form.
- **Real file** (a Codex reviewer session, 3 h, 103.5 MB, pre-#53 format):

  | Kind | Lines | Share of bytes | Payload |
  |---|---|---|---|
  | `response-chunk` | 13,890 | 91.3% | 25.6 MB raw |
  | `request` | 79 | 8.6% | 8.9 MB `body_b64` |

  - `/v1/models?client_version=0.157.1` was fetched 28 times, at about 523 KB each. That is 14.1 MB of chunk payload, more than the `/v1/responses` traffic.
  - Post-#53 projection: about 44 MB per 3 h per session. About 15 sessions were live at once today, and `proxy/` totals 2.3 GB.
- **Cost of the sync write** (this machine, Node 24, 13,890 appends of a 1,840-byte chunk, the recorded median, in the current code path):
  - total 1.9 s, p50 41 µs, p99 2.0 ms, **max 74 ms**;
  - one 523 KB models chunk takes 3.2 ms.

  Each of these is time the main process's event loop is blocked.
- **Readers.**
  - `src/main/storage/proxyEventsReader.ts` puts the **last 5 MiB** (`PROXY_EVENTS_BUNDLE_MAX_BYTES`) of the newest run's `proxy-events.jsonl` into a debug bundle.
  - `debugRetention.ts` finds run dirs by that filename and prunes whole run dirs.
  - Nothing reads the file live.
- **Claude's side** (#1273, claude-code-headless#62, merged; owned by W4): past a 256 MiB per-file budget it omits later request bodies (`body_omitted`) and keeps the earliest. That works for Claude because the bodies are the bulk and the responses stay. On Codex the response chunks are the bulk, so omitting them past a budget would drop exactly the recent traffic a bundle is for.

## Decisions (defaults taken, since the loop has no owner in the chat; each marked UNCONFIRMED)
1. **Rotate, don't omit.** When the next line would push the file past `eventsFileMaxBytes` (default **64 MiB**), rename it to `proxy-events.1.jsonl`, replacing any previous one, and start a fresh `proxy-events.jsonl`. At most 2 × 64 MiB per run, and the newest traffic is always complete. *Alternative:* Claude's omit-past-budget, which is bounded without rotation but loses the recent chunks. **UNCONFIRMED.**
2. **Async, ordered, bounded writer.** One `fs.WriteStream` per file, which keeps order. If more than **16 MiB** is queued and unwritten, the line is dropped and counted; the stream is never allowed to grow without bound. The stream's `error` disables the mirror silently, as before (best-effort, never breaks the proxy). **UNCONFIRMED** (16 MiB).
3. **Markers in the file.**
   - A new file after rotation starts with `{kind:'mirror-rotated', rotatedBytes, droppedEvents, droppedBytes}`.
   - After drops, the next line written is preceded by `{kind:'mirror-dropped', droppedEvents, droppedBytes}` (cumulative), so a gap is visible where it happened.
   - These are mirror-only lines. They are never emitted to listeners.
4. **`stop()` flushes.** It awaits the mirror's close, so the last events are on disk when a session ends. Tests await `flushMirror()` in place of relying on a synchronous write.
5. **The bundle reader reads across a rotation.** When the current file holds less than 5 MiB and `proxy-events.1.jsonl` exists, the tail of `.1` fills the remainder. A bundle taken just after a rotation keeps its 5 MiB of recent context. Claude never writes `.1`, so its path is unchanged.
6. **Not done:** deduplicating the repeated `/v1/models` bodies (32% of the bytes in the sample). Rotation already bounds disk; this only shortens the window. It is recorded as a residual rather than adding a path special case.

## Change
- **Package** (`codex-headless`, branch `fix/proxy-mirror-bound`):
  - new `src/proxy/eventsMirror.ts`: `EventsMirror { write(payload), flush(): Promise<void>, close(): Promise<void>, stats() }`, with the Buffer replacer moved here from `emit`;
  - `ResponsesProxy` gains the `eventsFileMaxBytes` option and `flushMirror()`;
  - `stop()` closes the mirror;
  - API.md is updated.
- **App** (branch `fix/codex-proxy-mirror-bound`): bump the package pointer to the package PR's merge; `proxyEventsReader.ts` gets the `.1` fill (Decision 5).
- **Pointer overlap:** #1319 also bumps `packages/codex-headless`. Whichever merges second merges main in and takes the newer pointer. The package commit is on top of #55.

## Tests
- **Package** (`responsesProxy.mirror.test.ts`, using the recorded `proxy-mirror/models-chunk-2865.json` chunk and the recorded event shape):
  - the existing tests are ported to `await flushMirror()`;
  - rotation at a small cap keeps every line, in order, across the two files; `.1` is replaced on the second rotation; the marker carries the counts;
  - a line is dropped, and counted, when the queue is over its bound; a `mirror-dropped` marker precedes the next written line;
  - an unwritable path never throws from `emit` and never breaks listeners;
  - `emit` does not write synchronously (red on main: the file has the line before `emit` returns);
  - `stop()` flushes.
- **App** (`proxyEventsReader`): a bundle taken right after a rotation holds the `.1` tail plus the current file, with a clean line boundary.

## Verification
- Package: full suite, `tsc --noEmit`.
- App: focused storage and codex suites, `npx tsc -b`, the full suite once.
- Boundary: no app launch. Event-loop relief is argued from the benchmark above, not measured in the app.

## Out of scope
- Claude's mirror (#1273, W4).
- `debugRetention.ts` (W4's area).
- Feed-debug and performance logs (already bounded).
- `/v1/models` dedupe (Decision 6).

## Execution notes
- **Ruling:** a rotation waits until the stream has opened its fd (`!stream.pending`). Why: renaming earlier moves or misses a file the stream has not opened yet, and a startup burst was lost in the mutant. Cost if wrong: during one open the file can overshoot the cap, bounded by the 16 MiB queue.
- **Ruling:** the bundle reader keeps its old behavior at exactly 5 MiB: the whole file, with no header. It reads `.1` only while the budget is positive. The truncation header's `dropped_bytes` now counts bytes, not UTF-16 units.
- **Ruling:** the package has no plan file of its own. This plan covers both PRs, and codex-headless#56 links it.
- **Scope change (steering q54, manager note `temp/manager/notes/proxy-reader-owner-2026-09-26.md`):** this PR owns ONE provider-neutral `readEventsTail(runDir)` for Codex and Claude. W4's #1273 app half builds on it.
  - It opens each generation once and sizes it by `fstat` on that handle. It never uses the run selection's saved size.
  - It skips `.1` when it is the same inode as the live handle, because a rotation between the two opens would otherwise duplicate lines.
  - It honours `bytesRead`.
  - It cuts both ends to whole lines.
  - It fills from `.1` only when the live file fit whole.

  Tests run on a recorded Codex chunk line and a recorded Claude `content_block_stop` line (`testing/fixtures/proxy-events-reader/claude-response-chunk.json`). They cover: rotation between selection and read (via a real interleave), a saved size from an old inode, the same-inode case, the two-generation 5 MiB cap, the live-only case, a shrink after `fstat`, and an unfinished last line. Against the same tests, main's reader fails 10, W4's `0905ba83` fails 8, and this PR's first version fails 4. The `bytesRead` mutant is equivalent here: zero-filled bytes are never `\n`, so the trailing line cut removes them. The guard stays anyway.
- **Review round 1** (6 Codex reviewers, all FIX-BEFORE-MERGE):
  - **Package** (`7575ae3`):
    - per-stream write accounting (A1);
    - a queue bound on the aggregate across open streams (A2);
    - a synchronous fd open, sized from that fd, so a rotation never waits for a pending open. Every write is marker plus line and must fit its file; what cannot fit is dropped and counted (A3/A4/B2/C2);
    - a drop marker written at close (B1/C1).
  - **Reader:**
    - a run is selected from `.1` when live is missing mid-rotation (A1/B1/C2);
    - a paired-open retry when the rotation lands between the opens (A2/B3);
    - adjacency comes from the live read starting at byte 0, not from "nothing dropped" (C3);
    - a vanished run reports `none` (B2);
    - an accurate header reason (A4);
    - byte-exact `dropped_bytes` (A5).
  - **Routed elsewhere:**
    - the Claude sidecar appended past the 5 MiB budget (A3) is pre-existing Claude wiring, so it goes to W4 (#1273);
    - a Codex prompt body can fall outside a 5 MiB tail (C1) is pre-existing policy, so it goes to a follow-up issue.
