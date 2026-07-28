# Dictation History, Stats, and Cold-Start Audio Loss

> **Status: PLAN — NOT YET IMPLEMENTED.** This document is the first commit on
> the branch. The PR that carries it will grow the implementation. Read this
> file before writing any code, and settle §0 first — three decisions there
> change what gets built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things, in one PR because they touch the same four files and the
same data:

1. **Fix the cold-start bug** where the first dictation of an app run returns
   nothing no matter how long the user speaks. Root cause is found and proven
   from 52 on-disk session journals; it is a one-character class of mistake in
   two places (§2).
2. **Give dictation a memory.** A durable, local, main-owned history of every
   successful dictation, surfaced in Settings → Dictation as a stats panel
   (lifetime words spoken, average words-per-minute) plus a recents list with a
   paste action — the same shape the standalone `flow-electron` Hub already
   ships, adapted to Agent Code's composer.

**Why one PR:** the stats feature needs the transcript, word count and audio
duration at exactly the moment `dictation:stream-stop` resolves — which is the
same handler whose error path the bug fix corrects. Splitting them means
touching `src/main/ipc/dictation.ts` twice and merging the second half against
a moved `return`. Per the repo's standing preference against multi-PR splits
for coupled work, they ship together.

**Architecture:** Nothing new is introduced structurally. The recorder →
IPC → provider → composer pipeline is unchanged. We add **one main-owned JSON
store** (mirroring `src/main/dictation/apiKeyStore.ts`'s file discipline and
the standalone app's `recentsStore.ts` semantics), **one IPC surface**, and
**one Settings marker row** (the escape hatch already used by
`dictation-api-key`, `cli-update-behavior`, `theme-picker`, and
`agent-code-conventions`).

**Tech Stack:** TypeScript, Electron main (`node:fs/promises`), React 18,
existing preload `contextBridge` API, Zustand workspace store for the paste
target. No new dependency.

---

## 0. Decisions to settle before Task 1

These are genuinely open. The plan below implements the **recommended** column;
if you disagree, change this section and the affected tasks before starting.

| # | Question | Options | Recommended |
| --- | --- | --- | --- |
| **D1** | What does "how many words have I spoken" count? | (a) words in the retained recents list (what `flow-electron` does — the number *shrinks* when old entries fall off the 200-entry cap) (b) a separate lifetime counter that only ever increases | **(b) lifetime counter.** (a) is a bug wearing a feature's clothes: the user asked "how many words have I spoken", and an answer that silently decreases when the ring buffer rolls is wrong. Costs one extra integer on disk. |
| **D2** | What does the row's primary action do? | (a) **Copy** to clipboard (what `flow-electron` does — it has no composer of its own) (b) **Paste** into the focused agent composer (c) both | **(c), with Paste primary.** Agent Code *has* a composer; `workspace.setDraftInput` + `applyPromptTemplateInsertMode` is the exact precedent (`CommandPalette.tsx:1103`). Copy stays as a secondary for terminal panes and external apps. See §4 Task 6 for the disabled-state rule. |
| **D3** | Does history record the raw transcript or the `<stt>`-wrapped text? | (a) raw (b) wrapped | **(a) raw**, wrapping applied at paste time via `wrapWithSttTag`. Storing wrapped text bakes today's tag format into every historical row; the standalone app made the same call (`displayTranscriptText` strips on read). |

**Non-decisions** (settled, do not relitigate): history is local-only and never
leaves the machine; audio bytes are never stored; the store is main-owned, not
renderer Settings, because `Reset Settings` must not wipe the user's dictation
history and Zustand state does not survive a reinstall.

---

## 1. Global constraints

- **Tests are expected, and they go beside their source.** `foo.ts` →
  `foo.test.ts`, per `testing/README.md`; `testing/` is only for what cannot be
  colocated. Filenames pick the Vitest project: `*.test.ts` → `unit` (node),
  `*.renderer.test.tsx` → `renderer` (happy-dom). The §2 fix in particular
  should be pinned by a spec — it is a silent data-loss bug that a reader could
  plausibly "simplify" back in, and a comment alone has already failed to
  prevent that once.
- **Comment policy** (`CLAUDE.md`): thick WHY comments. Every non-obvious guard
  in this plan exists because of a specific recorded failure — say which one.
  The §2 fix in particular MUST carry the evidence in a comment, or the next
  person "simplifies" it straight back into the bug.
- **Command/settings copy style** (`docs/command-style.md`): stable noun-phrase
  titles, no `Toggle`/`Enable`/`Show` verbs; state goes in a badge, not the
  title. `Dictation History` is the row name — not `View Dictation Stats`.
- **Privacy posture is inherited, not re-derived.** `dictationJournal.ts` states
  the contract: transcript text may cross into local 0600 files; audio bytes and
  API keys may not. The new store is subject to the same contract and must say
  so in its header.
- **Do not touch the rendering pipeline.** Nothing here goes near
  `src/renderer/src/rendering/**` or `features/feed/**`.
- **`packages/agent-voice-dictation` is a submodule.** §2's fix is in Agent Code
  only. The package is already correct (§2.4) — do not "fix" it, and do not
  bump the submodule pointer in this PR.

---

## 2. Part A — the cold-start bug

### 2.1 Symptom

On the first dictation after an app boot: the press feels slow, the live volume
curve moves normally while speaking, and on release the composer reports **"No
speech detected"** (or a Deepgram error toast) regardless of how long the user
spoke — a full minute of speech still yields nothing. Pressing again
immediately afterwards works perfectly, and every subsequent press that run
works. This has survived several previous fix attempts.

### 2.2 Evidence

The per-press debug journals (`<userData>/dictation-debug/<uuid>.dictation.jsonl`,
written by `src/main/dictationJournal.ts`) already recorded the whole failure.
52 sessions with recorder data, spanning 2026-07-14 → 2026-07-28, were
analysed. The correlation is exact:

| First `dataavailable` blob size | Sessions | Outcome |
| --- | --- | --- |
| **1 byte** | 7 (with real speech) | **100 % `OUTCOME: error`** — `Failed to process audio: corrupt or unsupported data.` |
| **≥ 496 bytes** | 43 | success, except 2 sub-second presses (§2.5) |

Every failing session is the **first press of its app run**, and the very next
press in the same run succeeds. Representative pair, 2026-07-28:

```
--- 39c3a5d5 (first press of the run — FAILS) ---
  1014 DEVICE   start:get-user-media:done   {"ms": 1013}          <- slow, cold
  1019 RECORDER recorder:start-called       {"timesliceMs": 120}
  1147 RECORDER recorder:dataavailable      {"chunkIndex": 0, "size": 1}     <- DROPPED
  1320 RECORDER recorder:dataavailable      {"chunkIndex": 1, "size": 3074}
  1324 CHUNK    renderer:produced           {"chunkIndex": 1, ...}           <- stream starts at 1
  ...
  6919 PROVIDER deepgram:error-message      {"message": "Failed to process audio: corrupt or unsupported data."}
  7697 ERROR    batch:upload:throw          {"message": "Deepgram transcription failed"}

--- c0e85bad (next press, 10s later — SUCCEEDS) ---
   127 DEVICE   start:get-user-media:done   {"ms": 127}           <- warm
   301 RECORDER recorder:dataavailable      {"chunkIndex": 0, "size": 1128}  <- kept
   301 CHUNK    renderer:produced           {"chunkIndex": 0, ...}           <- stream starts at 0
  ...  1863 chars transcribed
```

Both the WebSocket streaming path *and* the independent HTTP batch upload fail
with the same corruption error, which rules out anything provider-side,
network-side, or specific to one transport. The audio was captured fine — the
meter samples show `peak: 1` and the granted track is
`MacBook Air Microphone (Built-in)`, `muted: false`, `readyState: "live"`.

### 2.3 Root cause

`src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts:1001`

```ts
if (event.data.size <= 1) return
```

and its duplicate in `src/main/ipc/dictation.ts:284`

```ts
if (chunk.byteLength <= 1) return { kind: 'ignored' }
```

A `MediaRecorder` `dataavailable` Blob is **a slice of one continuous muxed
byte stream, not a self-contained frame.** The concatenation of every blob *is*
the WebM file; there is no per-blob framing, header, or padding. Therefore
dropping any non-empty blob deletes bytes from the middle of the container.
A `size === 0` blob is safe to skip (concatenating nothing is a no-op); a
`size === 1` blob is one real byte of the stream.

On a **cold** encoder — first `MediaRecorder` instantiation in the renderer
process after boot, where `getUserMedia` itself took 700–3100 ms instead of the
warm ~130 ms — the Opus encoder and WebM muxer have produced only a single byte
by the time the first 120 ms timeslice fires. That byte is the leading byte of
the EBML header. We drop it, the stream we ship begins mid-header, and Deepgram
correctly reports `corrupt or unsupported data`. Once warm, the muxer has the
full 1128-byte init segment ready before the first tick, chunk 0 passes the
guard, and everything works — which is precisely why the second press always
succeeds and why this looked like a mysterious warm-up race for so long.

The existing comment three lines below the bug states the invariant the code
then violates:

> *"it preserves the only invariant WebM streaming absolutely requires: byte
> order must match recorder order."*

Byte *order* was preserved. Byte *completeness* was not.

### 2.4 Why the package is not affected

Both correct implementations are in the repo already, which is how we know
`<= 1` was an unforced drift rather than a considered guard:

| Location | Guard | Correct? |
| --- | --- | --- |
| `packages/agent-voice-dictation/src/recorder/browserRecorder.ts:42` | `if (event.data.size === 0) return` | ✅ |
| `packages/.../flow-electron/src/renderer/status/App.tsx:228` | `if (evt.data.size > 0) {` | ✅ |
| `src/renderer/.../useComposerDictation.ts:1001` | `if (event.data.size <= 1) return` | ❌ |
| `src/main/ipc/dictation.ts:284` | `if (chunk.byteLength <= 1) return` | ❌ |

`git log -S` shows both bad guards arrived together in `2be41563 integrate
inline composer dictation` — the original port. No bug fix motivated them; they
are a transcription error of the package's `=== 0`.

### 2.5 Secondary finding (in scope, smaller)

Two sessions (`c4e3409b`, `57735428`) had a valid 1128-byte chunk 0 and still
ended in `OUTCOME: error`. Both were ~450 ms of actual recording (3 chunks,
~4 KB) that cleared the `audioDurationMs < 300` guard because that duration is
measured from `recording.startedAt` — which is stamped at *recorder creation*,
so it includes ~150 ms of startup before any audio exists. Deepgram's HTTP
endpoint rejected the near-empty clip and `transcribeDeepgram` threw
`SpeechProviderError('deepgram', 'Deepgram transcription failed', { status, details })`.

Two defects fall out of that:

1. **A too-short clip surfaces as a scary error toast instead of the normal
   "No speech detected" path.** The streaming provider got this right — it
   returned empty text cleanly. Only the batch path throws.
2. **The journal drops the diagnosis.** `emit(... 'batch:upload:throw', { message: err.message })`
   records only `"Deepgram transcription failed"`; the `status` and `details`
   fields that would have told us *what* Deepgram objected to are discarded.
   This is why §2.2 could not fully explain these two sessions from the journal
   alone.

### 2.6 Verification strategy

The fix is one line in each of two files, so the risk is not "does it compile"
— it is "did we actually stop losing the byte". Verify in this order:

1. **Reproduce cold.** Fully quit Agent Code. Relaunch with
   `AGENT_CODE_DICTATION_DUMP=1 npm run dev`. Speak ~5 s on the very first
   press. The dump path is logged at session start; run `ffprobe <file>`.
   Pre-fix this reports a malformed stream; post-fix it must report a valid
   `webm/opus` stream whose duration matches the utterance.
2. **Confirm from the journal.** The new session's first
   `CHUNK:renderer:produced` must have `chunkIndex: 0` even when the
   corresponding `recorder:dataavailable` shows `size: 1`, and `main:received`
   must show a matching `chunkIndex: 0` with the same `sha8`.
3. **Re-run the corpus script** in §5 against the journal directory; the
   `first sent idx` column must read `0` for every session including cold ones.

4. **Pin it with a spec.** Feed a synthetic `dataavailable` sequence of
   `[1, 3074, 2100]` bytes through the hook and assert main receives all three
   in order, with byte-exact totals and `chunkIndex` starting at `0`. Assert on
   the *bytes delivered*, not on "a chunk was sent" — an existence-only
   assertion passes while the leading byte is missing, which is exactly how
   this shipped. `TileLeaf/inputOwnership.renderer.test.tsx` is the natural
   neighbour; a new `useComposerDictation.renderer.test.tsx` is equally fine.

---

## 3. Part B — history and stats

### 3.1 Data model

```ts
// src/shared/types/dictation.ts (extend)
export type DictationHistoryEntry = {
  id: string              // main-minted UUID, stable across the store's life
  ts: number              // wall clock at commit
  text: string            // RAW transcript (D3) — never the <stt>-wrapped form
  words: number           // counted once at write time (see 3.3 for WHY)
  provider: DictationProvider
  /** Hold duration reported by the renderer at stop. Includes ~150 ms of
   *  recorder start-up and any trailing silence — it is the honest upper
   *  bound on speaking time, not a provider-reported audio length. WPM math
   *  depends on this; see 3.3. */
  audioDurationMs: number
  audioBytes: number
  chunkCount: number
  sttMs: number
}

export type DictationStats = {
  lifetimeWords: number      // D1: monotonic, survives recents eviction
  lifetimeSessions: number
  lifetimeSpokenMs: number
  averageWpm: number         // derived: lifetimeWords / (lifetimeSpokenMs / 60000)
  retainedEntries: number    // how many rows the recents list actually holds
}
```

### 3.2 Storage

New file `src/main/dictation/historyStore.ts`, writing
`<STATE_DIR>/dictation/history.json`, mode `0600`, atomic temp+rename — the
same discipline as `apiKeyStore.ts` (which is its sibling in that directory).

```jsonc
{
  "v": 1,
  "totals": { "words": 48213, "sessions": 641, "spokenMs": 17402913 },
  "entries": [ /* newest first, capped at MAX_ENTRIES = 200 */ ]
}
```

**Why totals live beside the entries rather than being derived from them:** D1.
The entries array is a ring buffer; the totals are monotonic. Deriving totals
from entries would make the lifetime word count fall every time an old entry is
evicted. Deleting a *single* row from the recents list therefore does **not**
decrement the totals — a delete is "stop showing me this text", not "I never
said it". `Clear History` (§4 Task 6) offers both: clear the list, or reset
everything including totals. Say this in the store header; it is the single
most likely thing for a future reader to get wrong.

**Not safeStorage.** The API key is encrypted because it is a rotating
third-party credential. Transcript history is user draft text, and
`dictationJournal.ts` already writes the same text to a 0600 JSONL under the
same privacy contract. Encrypting one and not the other would be theatre; more
importantly, safeStorage blobs are device-scoped and a Keychain reset would
silently destroy the user's whole history.

### 3.3 Word counting and WPM

Count words **once, at write time**, and store the number. Recomputing on read
means the displayed lifetime total changes if the counter's regex is ever
tweaked — a stat that silently rewrites history is worse than a slightly naive
one. Use a single shared `countWords` in `src/shared/lib/` so main (writing
totals) and renderer (any per-row display) cannot disagree.

WPM = `lifetimeWords / (lifetimeSpokenMs / 60_000)`.

**Be honest about the denominator in the UI.** `flow-electron`'s comment claims
WPM is based on "provider-reported audio duration ... not total wall-clock
pipeline duration", but Agent Code has no provider-reported duration — the only
number available at `stream-stop` is `audioDurationMs`, the renderer's hold
duration. That *does* exclude upload/transcription time (it is stamped before
the provider call), so it is not the pipeline duration either; it is
**hold time**, which overstates speaking time by the ~150 ms start-up plus any
silence before release. The stat is therefore a slight *under*estimate of true
speaking rate. Label the tile `Words/min` with a hover title saying it is
measured over hold time. Do not silently "correct" it with a fudge factor.

Exclude any entry with `audioDurationMs <= 0` from the WPM denominator.

### 3.4 Where it lands in the UI

Settings → **Dictation** category, as a new marker row after
`dictation-api-key`:

```
Inline Dictation            [toggle]
Speech Provider             [select]
Deepgram API Key            [key row]
Dictation History           [ ← new: stats tiles + recents list ]
Dictation Shortcut          [hotkey]
Dictation Mouse Button      [mouse]
```

Rendered by `<DictationHistoryRow />`, a self-subscribing component that reads
over IPC — exactly like `<DictationApiKeyRow />`, and for the identical reason
stated in `settingsRegistry.ts`: the value lives in main-owned state, not in
Zustand, so hoisting `getValue` into the registry would be a lie.

Layout, top to bottom:

- **Three stat tiles** — `Words` (lifetime), `Sessions` (lifetime),
  `Words/min` (with the small progress track `flow-electron` uses, scaled to
  180 wpm).
- **Recents list**, newest first, collapsed rows showing
  `time · duration · preview(100 chars)`; click to expand to full text with
  `Paste` / `Copy` / `Delete` actions.
- **Footer actions** — `Clear List` and `Reset Statistics`, both confirming.

---

## 4. Tasks

### Task 1: Fix the byte-dropping guards

- [ ] `src/renderer/.../useComposerDictation.ts:1001` — `event.data.size <= 1`
      → `event.data.size === 0`.
- [ ] `src/main/ipc/dictation.ts:284` — `chunk.byteLength <= 1` →
      `chunk.byteLength === 0`.
- [ ] Add a WHY comment at **both** sites recording: a `dataavailable` Blob is a
      slice of one muxed byte stream with no framing, so dropping a non-empty
      blob deletes container bytes; a cold encoder emits a 1-byte first blob
      (the leading EBML byte) which this guard used to discard, corrupting
      every first-press-after-boot recording; the package's
      `browserRecorder.ts` has always used `=== 0`; see §2 of this plan.
- [ ] Leave the `recorder:dataavailable` journal event emitting *before* the
      guard (it already does) — it is what made this diagnosable.

**Do not** change `nextChunkIndex` accounting. It already increments before the
guard, which is why the journals showed a clean `chunkIndex: 1` start and made
the drop visible. That is a feature.

**Verify:** §2.6 steps 1–3.

### Task 2: Preserve provider error detail

- [ ] In `src/main/ipc/dictation.ts`, the `batch:upload:throw` emit currently
      records only `err.message`. Widen it to carry `status` and `details` when
      the error is a `SpeechProviderError` (structural check — do not import
      the class across the submodule boundary just for an `instanceof`).
- [ ] Same for `streaming:stop:throw`.

**Verify:** trigger a failure with a deliberately bad key; the journal line must
now include the HTTP status.

### Task 3: Treat a rejected too-short clip as no-speech

- [ ] In the `stream-stop` catch block, when the upload throws **and**
      `session.chunkCount <= 3` **and** `params.audioDurationMs < 1000`, emit
      `OUTCOME: no-speech` with `reason: 'too-short-provider-rejected'` and
      return `{ kind: 'no-speech' }` instead of `{ kind: 'error' }`.
- [ ] Comment it against §2.5: the streaming path already returns empty text
      cleanly for these; only the batch path throws, and surfacing a red error
      for a half-second accidental press trains the user to distrust real
      errors.

**Do not** widen the existing `audioDurationMs < 300` pre-flight guard to
compensate. That threshold is deliberately generous because
`recording.startedAt` is stamped at recorder creation; raising it would start
discarding real short dictations.

### Task 4: The history store

- [ ] Create `src/main/dictation/historyStore.ts` implementing
      `readHistory()`, `appendEntry(entry)`, `deleteEntry(id)`,
      `clearEntries()`, `resetTotals()`.
- [ ] Header comment covering: local-only, text-not-audio, why totals are
      stored rather than derived (§3.2), why not safeStorage, and the
      delete-vs-totals rule.
- [ ] `MAX_ENTRIES = 200`, newest-first, `unshift` + truncate — same as the
      standalone `recentsStore.ts`.
- [ ] Corrupt/absent file returns an empty store; never throw. A broken history
      file must not be able to break dictation itself.
- [ ] Export `countWords` from `src/shared/lib/countWords.ts` and use it here.

### Task 5: Record on success

- [ ] In the `dictation:stream-stop` success branch, after `cleanText` is
      known, kick off `void appendEntry({...}).catch(...)` and return the
      transcript **without awaiting it**. The user is watching a
      "transcribing…" pill; a disk write must not sit between the provider
      answering and the composer filling. See the Known Risk note below.
- [ ] Record **raw** text (D3).
- [ ] Failure to write history must **never** fail the dictation — the
      `.catch()` emits an `ERROR` journal event and nothing else. The
      transcript reaching the composer is the product; the history row is
      bookkeeping.
- [ ] Because the write is not awaited, `cleanupDictationIpcResources()` and
      the `before-quit` path must flush it, or a dictation immediately followed
      by ⌘Q loses its row. Mirror how `DictationDebugJournalRegistry.flushAll()`
      is already wired into shutdown.

### Task 6: IPC + preload

- [ ] `dictation:history-list`, `dictation:history-delete`,
      `dictation:history-clear`, `dictation:history-reset-totals` in
      `registerDictationIpc`. All return the fresh
      `{ stats, entries }` snapshot so the renderer updates in one round-trip
      (same pattern as `setDeepgramApiKey` returning the fresh status).
- [ ] Corresponding methods in `src/preload/api/dictation.ts` and types in
      `src/preload/api/types.ts`.

### Task 7: The Settings row

- [ ] Add `control: { type: 'dictation-history' }` to the `SettingDefinition`
      union in `settingsRegistry.ts`, with the marker-row comment explaining
      it fronts main-owned state.
- [ ] Register the row: id `dictation-history`, category `dictation`, title
      **`Dictation History`**, keywords covering
      `history, recents, stats, words, wpm, transcript, paste`.
      `metadata: { scope: 'app', apply: 'immediate', storage: 'external-files' }`
      — it is a JSON file in `STATE_DIR`, so `Reset Settings` does not clear it
      and the badge must say so.
- [ ] Render it in `SettingsList.tsx` alongside the other marker rows.
- [ ] Create `src/renderer/src/features/voice-dictation/DictationHistoryRow.tsx`
      per §3.4. Loads on mount, refreshes after every mutation.

### Task 8: Paste and copy

- [ ] **Paste** (D2 primary): resolve the target with
      `commandTargetSessionId(workspace)`; if it is an agent pane, write
      `workspace.setDraftInput(sessionId, applyPromptTemplateInsertMode(currentDraft, wrapWithSttTag(text), 'append'))`
      and close the settings modal so the user lands on the composer.
      Reuse the existing helper rather than reimplementing separator logic —
      `CommandPalette.tsx:1103` is the precedent.
- [ ] Disable Paste with an explanatory title when there is no agent target
      (terminal-only pane, or nothing focused). Do **not** silently no-op.
- [ ] **Copy** (secondary): `navigator.clipboard.writeText`, wrapped form,
      matching the standalone app.
- [ ] Import `wrapWithSttTag` from `agent-voice-dictation/composer` — the
      **subpath**, not the package root. The root re-exports the Deepgram
      streaming module which imports `node:crypto` and will break the renderer
      bundle. This is documented in `flow-electron/src/renderer/hub/Home.tsx`
      and is a real trap.

### Task 9: Retention and pruning

- [ ] The recents cap (200) bounds the file, but confirm the store is included
      in whatever the app already prunes at boot. `pruneOldDictationDebugLogs()`
      handles the *journals*, not this file; a 200-entry JSON is small enough
      that no prune is needed — state that explicitly in the header so nobody
      adds a redundant one.

### Task 10: Verification

- [ ] `npx tsc -p tsconfig.node.json --noEmit false` and `tsconfig.web.json`
      (raw `tsc` on **both** projects — `electron-vite build` and `vitest` do
      not type-check).
- [ ] `npm test` once, at the end.
- [ ] `npm run check:keybindings` (a new settings row does not add a binding,
      but the check is cheap and the registry changed).
- [ ] Manual: cold-boot dictation per §2.6; then a second dictation; confirm a
      history row appears with a plausible word count and the WPM tile moves.
- [ ] Manual: paste into an agent composer; paste with a terminal pane focused
      (must be disabled, not silent); delete a row and confirm lifetime words
      does **not** drop.

---

## 5. Reproduction tooling

The analysis script used for §2.2 is worth keeping during implementation. It is
**not** committed (it is diagnostics, not product), but reproduce it in the
scratchpad:

```
node analyze.mjs "$HOME/Library/Application Support/agent-code/dictation-debug"
```

It reads every `*.dictation.jsonl`, and prints one row per press: first-chunk
size, first *sent* chunk index, renderer/main chunk counts, peak audio level,
Deepgram open latency, batch bytes, and the terminal outcome. The
"first sent idx" column is the fix's acceptance signal — it must be `0`
everywhere.

---

## Self-Review

**What this plan is confident about:** the §2 root cause. The correlation is
52-for-52 with a mechanism that follows from how `MediaRecorder` chunking works
rather than from pattern-matching, two independent transports fail identically,
and the two correct implementations of the same guard are sitting in the same
repo. The remaining uncertainty is only whether the dropped byte is
specifically the EBML leading byte or some other header byte — which changes
the narration, not the fix.

**What this plan is least sure about:** D1/D2/D3, which is why they are §0 and
not buried. Also §3.3 — "words per minute over hold time" is a defensible stat
but it is not the stat a user would assume, and if the number reads low in
practice the honest fix is a better denominator (e.g. subtracting leading
silence from the meter samples we already collect), not a multiplier.

**Deliberately not in scope:** a device picker (the built-in-mic force in
`pickAudioConstraints` stays as-is); polishing transcripts through OpenRouter
(the package supports it, Agent Code does not expose it); search over history;
any sync or export. Each is a separate PR if wanted.

**Known risk:** Task 5 writes to disk inside `stream-stop`, the handler the user
is waiting on with a "transcribing…" pill visible. The task therefore specifies
a non-awaited write plus a shutdown flush. That trade is deliberate and it has
a real cost: the flush is now load-bearing, so if a future refactor moves
`appendEntry` or changes the quit sequence, dictations taken seconds before a
quit will silently stop being recorded. If that proves fragile, the fallback is
to await the write and accept a few milliseconds — not to drop the flush.
