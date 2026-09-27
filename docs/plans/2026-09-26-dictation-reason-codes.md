# Every dictation ends with a reason code, and every phase has a deadline (#243)

Issue #243 (remaining after its first PR): **reason codes** (non-success outcomes are free text today) and **deadlines** for connect, first-audio, final and insertion. Acceptance: every non-success outcome carries a reason code, and each of the four phases has a deadline taken from the recorded `dictation-debug/*.dictation.jsonl`.

Size: standard plan. The code shape is known (one renderer hook, one IPC module), but the taxonomy, the deadlines and the user-facing wording are real choices.

## Evidence (verified 2026-09-27, do not re-derive)
Corpus: the owner's `~/Library/Application Support/agent-code/dictation-debug/`, 148 session journals (1.1 GB, mostly `AUDIO_LEVEL` samples).

**Terminal outcomes.**
- Main's `OUTCOME` rows exist in only **92 of 148** sessions: success 51, error 24, no-speech 17. The other 17 no-speech rows break down as provider-returned-empty 9, too-short-provider-rejected 6, too-short 2.
- **56 sessions end with no outcome at all:**

| Shape | Count | What happened |
|---|---|---|
| `stop:pending-pushes-settled → cleanup`, no stream id | 25 | The user held the key 1–3.8 s, but `getUserMedia` took most of it (up to 3,836 ms; over 500 ms in 14 of 25), so the recorder had run only 2–611 ms when the stop came (0–1 chunks). The renderer says **"No speech detected"**, which is false: the speech happened before the mic was open. Main is never called, so no outcome row. |
| `start:begin → stop:called` while `starting` | 13 | An accidental tap during `getUserMedia`. `start()`'s pending-discard branch stops the tracks and returns without any journal event. |
| `start:get-user-media:error → start:error` | 7 | Microphone unavailable or denied (for example `OverconstrainedError` for a disconnected EarPods). Renderer-only; the message is curated (`dictationAudioInputError`) but there is no outcome row or code. |
| `stop:called ×2` after idle | 6 | Stops arriving with no recording (idle). Not a dictation; no outcome is right. |
| `cancel-recording → cleanup` | 3 | A short-press discard; no outcome row. |
| other | 2 | One session with a drain but no stop (the 32.8 h #1299 session); one with `start:begin` only. |

**Errors.** All 24 main errors carry free text:
- 23 × "Deepgram transcription failed";
- 1 × "fetch failed".

Behind them, `batch:upload:throw` shows 28 × **HTTP 400** "failed to process audio" (the 6 short ones were re-labelled no-speech), 1 × **408**, and 1 × network (`fetch failed`, no status).

**Phase timings** (ms; p50 / p95 / max):
- connect, stream-start IPC request → result: 4 / 19 / 55;
- first audio, `recorder:start-called` → first `renderer:produced`: 177 / 245 / 626;
- Deepgram preview socket open (preview only, not authoritative): 231 / 444 / 7,379;
- final, `stop:called` → main outcome: 466 / 1,659 / 14,320 (the batch upload is 450 / 1,646 / 14,316);
- insertion, outcome success → `TRANSCRIPT committed`: 3 / 11 / 21. It is synchronous (`writeInput`).

**Code** (`src/main/ipc/dictation.ts`, `useComposerDictation.ts`):
- main returns `{ kind: 'error', message: err.message }` and the renderer shows `result.message` verbatim;
- no phase has a timer, except the accidental-tap `streamStartTimer`;
- `startDictationStream` awaits a keychain read (`readDeepgramApiKeyForRuntime`) with no bound.

## Decisions (defaults; UNCONFIRMED until the manager or owner says otherwise)
1. **Reason codes: one shared union**, `DictationOutcomeReason` in `src/shared/types/dictation.ts`. Every terminal path records exactly one `OUTCOME` row `{ kind, reason }`, in main when main decides, in the renderer otherwise. Codes:
   - `success`
   - no-speech: `no-speech.too-short`, `no-speech.provider-empty`, `no-speech.provider-rejected-short`
   - cancelled: `cancelled.short-press`, `cancelled.hidden`, `cancelled.unmount`, `cancelled.shutdown`
   - microphone: `mic.unavailable`, `mic.denied`, `mic.error`, `mic.opened-late`, `recorder.error`, `recorder.no-audio`
   - `config.missing-api-key`
   - provider: `provider.bad-audio` (400), `provider.auth` (401/403), `provider.rate-limited` (429), `provider.timeout` (408 or our deadline), `provider.unavailable` (5xx), `provider.rejected` (other 4xx), `network`
   - deadlines: `connect.timeout`, `final.timeout`
   - delivery: `delivery.hidden-terminal`, `delivery.abandoned`
   - `unknown`
2. **User-visible text comes from the code, never from provider or IPC text** (q22, q39). A fixed sentence per code, bounded. Main's IPC error result gains `reason`; the renderer maps the reason to a sentence. The free `message` stays only in the journal.
3. **`mic.opened-late` replaces the false "No speech detected".** A stop with zero chunks whose recorder ran for less than the hold threshold gets its own sentence: "Nothing was recorded — the microphone took {n} s to open. Hold the key until the indicator shows listening." (wording UNCONFIRMED).
4. **Deadlines from the corpus**, with at least 3× the recorded maximum:
   - **connect:** 10 s from the stream-start request to its result (max 55 ms; the unbounded keychain read is the risk). On expiry: `connect.timeout`; the recording is discarded and the stream cancelled.
   - **first audio:** 2 s from `recorder:start-called` to the first non-empty chunk, while still recording (max 626 ms). A muted mic still encodes silence, so this fires only on a real capture failure. On expiry: `recorder.no-audio`; stop and tell the user.
   - **final:** 30 s for main's batch transcription (max 14.3 s), enforced by aborting its existing `AbortController`: `provider.timeout`.
   - **Ruling:** insertion is synchronous (`writeInput`), so it has no timer; a timer on a synchronous write can never fire. Its non-delivery cases get codes (`delivery.*`), and a throwing write is `unknown` with its own journal row. Cost if wrong: if insertion ever becomes asynchronous, it needs a deadline then.
5. **Out of scope:** #1299, the maximum recording duration, silence stop and sleep/blur release (owner-only), and microphone prewarm (would reduce `mic.opened-late`; separate change). Deepgram preview-socket timing is preview-only and gets no deadline.

## Change
- `src/shared/types/dictation.ts`: `DictationOutcomeReason`, `dictationReasonMessage(reason, detail?)` (curated, bounded), and `classifyProviderFailure(status?)`.
- `src/main/ipc/dictation.ts`:
  - every `OUTCOME` row and every non-success IPC result carries `reason`;
  - the batch upload gets the 30 s abort deadline;
  - `stream-start` rejections carry `config.missing-api-key`.
- `useComposerDictation.ts`:
  - one `finish(reason, detail)` helper records the renderer-side `OUTCOME` row and shows the curated sentence;
  - every terminal branch calls it (pending-discard, short press, getUserMedia error, recorder error, no stream id, hidden terminal, abandoned, shutdown, main results);
  - adds the connect and first-audio timers, cleared in `cleanup`.
- Preload types: `reason` on the stop and start results.

## Tests (fail-first, from the recordings)
- **Classification over recorded journals.** A small committed fixture of real session journals, reduced to their lifecycle rows. It contains no audio-level samples, chunk bytes or transcript text, and its paths and device labels are redacted at the same length. It holds one session of each shape in the census above. A test replays each through the pure outcome classifier and expects the code, for example `mic.opened-late` for the 3.3 s `getUserMedia` session. The `provider.*` codes come from the recorded `batch:upload:throw` rows (400 / 408 / no status).
- **Main (`dictation.ts` IPC test).** A 400 returns `{ kind: 'error', reason: 'provider.bad-audio' }` with the curated sentence, not "Deepgram transcription failed". The batch deadline aborts at 30 s with fake timers: `provider.timeout`. A missing key gives `config.missing-api-key`.
- **Renderer hook tests.** The pending-discard tap records `cancelled.short-press`. A zero-chunk stop after a slow `getUserMedia` records `mic.opened-late` and does not say "No speech detected". No chunk within 2 s gives `recorder.no-audio`. No stream-start result within 10 s gives `connect.timeout`. Every test asserts exactly one `OUTCOME` row.

Each is red on main.

## Verification boundary
Real microphone and Deepgram behaviour cannot be run here (never launch the app). The deadlines are checked with fake timers against the recorded maxima; real-world tuning is reported as a residual.

## Review round 1 (#1340) and steering q61
Reviewers A and C returned FIX-BEFORE-MERGE (B pending). All their findings were valid:
- **Unknown microphone error text reached the user (A, blocker; C).** `dictationAudioInputError` fell through to `error.message`. It now returns a fixed sentence, and the only interpolated value (the user's own device label) is capped at 80 characters.
- **Unmount while the microphone was opening (A, blocker).** `start()` resumed on an unmounted hook and started a recorder nothing owned. `unmountedRef` is checked after the capture resolves (and in `start()`'s catch): the late stream is closed and nothing is built. The unmount writes the session's one `cancelled.unmount` row.
- **Two terminal decisions (A).** A deadline that failed the recording while `stop()` was awaiting was followed by `stop()`'s own "No speech detected". `failRecording` is now the single owner: `stop()` returns when the recording is already discarded, at every await. The first-audio timer no longer fires once the user has released.
- **Shutdown dropped its OUTCOME (A).** The late-row fence now lets OUTCOME through. Only admitted handlers write it, and they are joined before the final flush.
- **A 408 downgraded to no-speech (A, C).** 408 is excluded from the short-clip downgrade, so the recorded 408 (370 ms, 3 chunks) is now `provider.timeout`.
- **Terminal insertion was not awaited (C). This reverses the plan's earlier insertion ruling.** For a terminal sink, insertion is an async session write that can answer false or reject. `committed` is written only after it answers true. False, rejection, or no answer within 5 s (`terminalInsertion`) gives a `delivery.failed` row and a sentence. The composer sink stays a synchronous write.
- **A hung chunk push stranded `stopping` (C).** The drain before the stop IPC (pending pushes, and a queued stream start) is bounded by `drain` (10 s). On expiry, the recording ends as `final.timeout` and main's half is cancelled.
- **Wording (C).** Margins are stated per phase: connect 180×, first audio 3.2×, final 2.1× (not "3×"). The fixture had five sessions; it now has six, with the one recorded 408 added under the same redaction.

Tests: 10 new cases.
- Eight are red on the round-1 head: the recorded 408, shutdown OUTCOME, unknown-error text, unmount during mic open, connect timeout during stop, hung push, and terminal paste answering false or rejecting.
- Two pin mutation survivors (unmount mid-recording, IPC throw); removing each guard fails them.

## Review round 2 (#1340, reviewer c; the last round)
- **A queued drain that hangs never published the stream id,** so the drain deadline's cleanup could not cancel main's session. `startedStreamId` is set the moment main answers, and every cancel path uses `id ?? startedStreamId`.
- **Unmount during device enumeration** still asked for a microphone afterwards. `start()` now checks `unmountedRef` between enumeration and `getUserMedia` too.
- **A terminal-delivery timeout from dictation A reported during dictation B,** unattributed. If a newer recording is active, the sentence names "the previous transcript", and the overlay the new recording is using is not touched. The `delivery.failed` row is always written.
- **Survivor (terminal success untested):** a test asserts the bracketed-paste write and `committed` once it answers true. Replacing the write with `Promise.resolve(false)` fails it.

Tests: 4 new. 3 are red on `deafa064`; the success-path pin kills its mutant.

## Steering q67: the History promise
`delivery.failed` said "It is in Settings → Dictation → History." But main writes History without awaiting it, and a failed write only reaches the debug journal. With both the paste and the History write failed, the user was told the transcript was saved when it was gone.
- **Fix:** on a failed terminal paste, the renderer reads History, which is queued behind in-flight appends. It promises History only if this transcript's row is among the newest entries. Otherwise the sentence says it could not be saved either. The `delivery:failed` row records `savedInHistory`. No filesystem or IPC text is shown.
- Tests: saved, and not saved (a write that failed), both red on `b07ca169`. Two older timing-based tests (the recorded tap, and the late mic) now fake `Date`, so the recorded 49 ms and 3,280 ms are measured exactly under any load.
- **Round-2 A's remaining findings** (the hung-drain cancel, and the late paste taking over the global overlay) were fixed in `b07ca169`. Its test caveat, that the connect-timeout-during-stop test advanced timers synchronously, is fixed: the test now uses `advanceTimersByTimeAsync`, and removing the guard fails it.

## Steering q71: saved, absent or unknown, by this append's identity
q67's check still claimed more than it knew. A failed History read was reported as "could not be saved", when only the read had failed. And matching `text === raw` among the newest five rows let an older dictation with the same words ("yes", "continue") make a failed append look saved.
- **Fix:** main mints the History row id before the un-awaited append and returns it as `historyId` on the success result. `appendEntry` accepts a caller id.
- **The renderer asks History for exactly that id,** giving `DictationHistorySave`:
  - `saved`: the row is there;
  - `absent`: History was read, serialised behind the append, and the row is not there;
  - `unknown`: the read failed, or there is no id.
- **Copy:** only `saved` says "It is in … History"; only `absent` says "could not be saved". `unknown` gets the hedge "Check Settings → Dictation → History; it could not be confirmed there."
- **Journal:** the `delivery:failed` row records `history` instead of `savedInHistory`.
- **Tests:**
  - renderer: this append's row present, only an older identical transcript present, and a rejected read;
  - main: the returned id is the appended id;
  - store: a caller id is stored verbatim.
- **Separate:** the owner's disposition on deadlines and wording is unchanged by this.

## Verification pass (a, c at `03f6ccdc`; b at `2abc991e`)
- **a (major): unmount and short-press left main's stream alive** when the queued drain hung. Those two exits kept the old `id`-or-promise cancel shape; only stop and fail had learned `startedStreamId`.
  - Fix: one `releaseMainStream(recording)` helper serves all four exits.
  - Tests: unmount and short press during a stalled drain, both red before.
  - Also committed:
    - a's overlay assertion on the late-failure test (killed the `!previous` survivor);
    - its read-ordering probe as a store test.
- **c (minor residual): a late paste failure while the next dictation was still `starting`** was named "the transcript" and painted the new overlay, because `activeRef` is published only once the mic opens.
  - Fix: `previous` also counts any non-idle lifecycle. It cannot be stale for this dictation, because stop() set 'idle' synchronously before this callback.
  - Test: red before.
- **b: MERGE-READY at `2abc991e`.** Its one real-behaviour survivor, the stop-catch single-owner guard (recorder error + hung push + drain deadline), is stated as a residual.
