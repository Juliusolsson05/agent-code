# Dictation Debug Dump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every dictation session, write one FAT JSONL debug file under `<userData>/dictation-debug/` capturing every layer of the pipeline (device pick, recorder lifecycle, every chunk, every audio-level sample, IPC round-trips, provider events, final outcome) so we can diagnose why the live-streaming transcript preview and the sine-wave indicator silently fail even when the final batch transcript comes back fine.

**Architecture:** Clone the `ghostJournal` shape — a per-session append-only JSONL with 100ms batched writes, a process-wide `DictationDebugJournalRegistry` flushed on app quit, written through a single new IPC channel (`dictation:debug-event`) used by both the renderer and the main process. Renderer-side events are emitted from `useComposerDictation.ts` at every existing `debug(...)` call site (plus new audio-level sampling at ~10Hz). Main-side events are emitted from `src/main/ipc/dictation.ts` at every existing `[dictation:trace]` console-debug. The journal file is keyed on a renderer-minted `debugSessionId` (not on `streamId`, since streamId is null during the first ~180ms of every press); start time is wall-clock + `tMs` offset.

**Tech Stack:**
- Node `fs/promises` (append-only writes, 0o600 file mode) — same pattern as `src/main/ghostJournal.ts`
- Electron `app.getPath('userData')` for the file root
- Electron `ipcMain.on` (fire-and-forget, like `ghost:append`) — no return value
- React `useRef` + `requestAnimationFrame` already in `useComposerDictation.ts`; we add throttled emission
- `node:crypto` for short SHA8 fingerprints of chunk payloads (collision detection across IPC without logging the bytes themselves)

---

## File Structure

**Create:**
- `src/main/dictationJournal.ts` — `DictationDebugJournal`, `DictationDebugJournalRegistry`, `dictationDebugLogPath()`, `pruneOldDictationDebugLogs()`. Direct sibling of `ghostJournal.ts`, near-identical shape.
- `src/preload/api/dictationDebug.ts` — single-method preload bridge: `recordDictationDebugEvent(sessionId, layer, event, data)`. Lives next to `dictation.ts` to keep the dictation surface together.

**Modify:**
- `src/preload/api/types.ts` — add `DictationDebugLayer`, `DictationDebugEventInput` types (used by the new preload method).
- `src/preload/api/index.ts` — re-export the new method on `window.api`.
- `src/main/ipc/dictation.ts` — accept the new IPC channel and forward to the journal; also emit MAIN/PROVIDER events at session start, every chunk receive, batch upload start/end, and errors.
- `src/main/ipc/index.ts` — pass `dictationDebugJournals` into `registerDictationIpc`.
- `src/main/index.ts` — construct the registry next to `ghostJournals`, wire `flushAll()` on `before-quit`, run `pruneOldDictationDebugLogs()` on `whenReady`.
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts` — mint a `debugSessionId` per recording, emit events from every existing `debug(...)` call site, instrument `startMeter` to emit AUDIO_LEVEL samples at ~10Hz, emit DEVICE events from `pickAudioConstraints()`, emit TRANSCRIPT events from the onDictationStreamTranscript subscription, emit final OUTCOME event in `stop`.

**No new tests, no new `test:*` scripts** — per `feedback_no_test_bloat.md`. Verification is manual: run cc-shell, dictate, open the JSONL, eyeball it.

---

## Event Schema (the contract every task adheres to)

Every line in the JSONL is one event of this shape. Types live in `preload/api/types.ts`:

```ts
export type DictationDebugLayer =
  | 'META'        // session lifecycle: created, recorder-config, final outcome
  | 'DEVICE'      // mic enumeration, getUserMedia result, granted track labels
  | 'RECORDER'    // MediaRecorder lifecycle: start, error, stop, dataavailable
  | 'CHUNK'       // per-chunk audit across renderer + main, with sha8 + size
  | 'AUDIO_LEVEL' // 7-band analyser samples (the sine-wave data), ~10Hz
  | 'IPC'         // every renderer↔main round-trip with id + result kind
  | 'PROVIDER'    // streaming WS trace + batch upload trace (deepgram only)
  | 'TRANSCRIPT'  // every live preview callback + final committed text
  | 'OUTCOME'     // success / no-speech / error / cancel — terminal event
  | 'ERROR'       // anything that throws / rejects

export type DictationDebugEventInput = {
  layer: DictationDebugLayer
  event: string                       // short snake_case identifier
  data?: Record<string, unknown>      // freeform payload; see Privacy below
}

// On-disk form (what main writes). `tMs` is computed main-side: ts - sessionStartedAtMs.
export type DictationDebugEvent = DictationDebugEventInput & {
  ts: number    // wall-clock ms (Date.now())
  tMs: number   // ms since session start
}
```

**Privacy invariants — never violate, audit every payload before merge:**
- **NEVER** log raw audio bytes. Log `bytes` (size) and `sha8` (first 8 chars of SHA-256 hex over the chunk).
- **NEVER** log API keys. Log `provider` + boolean `hasApiKey`.
- **Transcript text IS logged**. It is user-draft, the file is local under `<userData>` with 0o600 mode and 0o700 dir mode. The whole point is to see what Deepgram returned vs. what reached the composer.
- **Device labels are logged** in plaintext (e.g., "Julius's AirPods Pro Microphone"). This is fine; the file is local and the user owns it.

---

## Task 0: Sanity check — read these files, confirm shapes

Before any code: open the four reference files this plan rests on. If any of them has materially changed since the plan was written, stop and re-plan.

- [ ] **Step 1: Read each reference file end-to-end**

Files to read (sizes will refresh in your head — these change over time):
- `src/main/ghostJournal.ts` (the pattern we're cloning)
- `src/main/ipc/dictation.ts` (where we wire main-side instrumentation + the new IPC handler)
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts` (where we wire renderer-side instrumentation)
- `src/preload/api/types.ts` (where the new types land — search for `FeedDebugPersistEntry` to see the existing precedent for debug-payload types)

- [ ] **Step 2: Confirm the existing `debug()` helper sites still exist**

```bash
grep -n "debug(" src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts | head -30
```
Expected: ~20+ call sites (start:begin, start:get-user-media:done, stream:start:request, stream:start:result, stream:drain-and-publish, stream:start:error, recorder:dataavailable, recorder:chunk:queued-local, recorder:chunk:push-ipc, recorder:chunk:push-error, recorder:error, recorder:start-called, stop:called, stop:short-press-discard, stop:stopping-recorder, stop:request-data, stop:request-data-error, stop:recorder-stop-called, stop:recorder-stopped, stop:pending-pushes-settled, stop:ipc-result, cancel-recording, cleanup, start:error). Every one of these will become a debug-journal emission AND keep its `console.debug`.

- [ ] **Step 3: Confirm `[dictation:trace]` call sites in main**

```bash
grep -n "dictation:trace\|dictation:dump" src/main/ipc/dictation.ts
```
Expected: at least two `[dictation:trace]` lines (batch:start, batch:upload) and four `[dictation:dump]` lines (env-flagged WebM dump). The new instrumentation is parallel to these — keep the existing console output, add journal emission alongside.

- [ ] **Step 4: Run the diagnostic harness once to confirm the streaming code path still passes**

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_EXTRA_CA_CERTS \
      SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
npx tsx vendor/in_progress/dictation-repro/12-stream-flux-chromium-exact.ts 2>&1 | tail -10
```
Expected: `VERDICT: PASS` with sentinels matched. If this fails, the harness moved out from under us; investigate before continuing.

---

## Task 1: Add new types to preload/types.ts

**Files:**
- Modify: `src/preload/api/types.ts` (add at end, near `FeedDebugPersistEntry` for consistency)

- [ ] **Step 1: Add the new types**

Add this block after the `FeedDebugPersistEntry` type (around line 234 in the current file; if line numbers have shifted, search for `FeedDebugPersistEntry` and insert after it):

```ts
// Dictation per-session debug dump.
//
// Every dictation session writes one append-only JSONL file under
// <userData>/dictation-debug/<debugSessionId>.dictation.jsonl. The
// renderer and main both emit events through window.api.recordDictationDebugEvent
// (fire-and-forget); main batches them at 100ms per file. See
// src/main/dictationJournal.ts for the on-disk layout and
// src/main/ipc/dictation.ts for the privacy invariants this surface
// is required to honour.
//
// `debugSessionId` is renderer-minted at recorder construction time —
// NOT the Deepgram stream id. Deepgram's id is null for the first
// ~180ms of every press (we queue chunks locally to discard accidental
// taps), so keying the debug file on it would lose all the most
// interesting startup events.
export type DictationDebugLayer =
  | 'META'
  | 'DEVICE'
  | 'RECORDER'
  | 'CHUNK'
  | 'AUDIO_LEVEL'
  | 'IPC'
  | 'PROVIDER'
  | 'TRANSCRIPT'
  | 'OUTCOME'
  | 'ERROR'

export type DictationDebugEventInput = {
  layer: DictationDebugLayer
  event: string
  data?: Record<string, unknown>
}

export type DictationDebugEvent = DictationDebugEventInput & {
  ts: number   // wall clock, Date.now()
  tMs: number  // monotonic offset from session start
}
```

- [ ] **Step 2: Type-check passes**

Run: `npm run typecheck`
Expected: PASS (no usages yet; just added types).

- [ ] **Step 3: Commit**

```bash
git add src/preload/api/types.ts
git commit -m "feat(dictation): add DictationDebugLayer/Event types"
```

---

## Task 2: Implement DictationDebugJournal (main process)

**Files:**
- Create: `src/main/dictationJournal.ts`

- [ ] **Step 1: Write the journal module**

Create `src/main/dictationJournal.ts` with this content. It mirrors `ghostJournal.ts` structurally — same 100ms batch interval, same registry shape, same `mkdir`-on-first-write trick. Read `ghostJournal.ts` while writing this to keep the shapes parallel.

```ts
// Per-dictation-session debug-event writer.
//
// Mirrors src/main/ghostJournal.ts deliberately: same 100ms drain
// cadence, same mkdir-on-first-write trick, same "process owns the
// writer until quit, flushAll on before-quit" lifecycle. The two
// files are intentionally near-duplicates — refactoring them into a
// shared "BatchedJsonlWriter" is YAGNI until a third caller shows up.
//
// One file per dictation press: <userData>/dictation-debug/<id>.dictation.jsonl.
// The id is a renderer-minted UUID, NOT the Deepgram stream id; see
// the DictationDebugLayer comment in preload/api/types.ts for the
// reason.
//
// Privacy contract:
//   * file mode 0o600, dir mode 0o700
//   * we never see audio bytes here — callers send `bytes` + `sha8`
//   * transcript text crosses through; it is user draft, file is local
//
// Disk-pressure contract:
//   * pruneOldDictationDebugLogs() runs at startup; default keep is
//     14 days. A FAT file per press × dozens of presses per day adds
//     up; without pruning we'd grow forever.

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { DictationDebugEvent, DictationDebugEventInput } from '@preload/api/types.js'

const FLUSH_INTERVAL_MS = 100

// 14 days of debug history. Tuned so a normal user keeps "yesterday's
// busted session" recoverable but doesn't accumulate a year of mic
// recordings worth of metadata. Tune with care: lowering this hides
// failure histories from future investigations.
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

export class DictationDebugJournal {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ensuredDir = false
  private draining = false
  // sessionStartedAtMs is captured on first append, NOT in the
  // constructor: a session that never emits an event also never
  // creates a file, so there is no "started at" to report yet.
  // First append latches it; subsequent appends compute tMs against
  // this anchor.
  private sessionStartedAtMs: number | null = null

  constructor(private readonly filePath: string) {}

  append(input: DictationDebugEventInput): void {
    const now = Date.now()
    if (this.sessionStartedAtMs === null) this.sessionStartedAtMs = now
    const event: DictationDebugEvent = {
      ts: now,
      tMs: now - this.sessionStartedAtMs,
      ...input,
    }
    this.queue.push(JSON.stringify(event) + '\n')
    this.scheduleDrain()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, FLUSH_INTERVAL_MS)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    if (this.queue.length === 0) return
    this.draining = true
    try {
      const batch = this.queue.splice(0).join('')
      await this.appendRaw(batch)
    } finally {
      this.draining = false
    }
    if (this.queue.length > 0 && !this.timer) this.scheduleDrain()
  }

  private async appendRaw(content: string): Promise<void> {
    try {
      await appendFile(this.filePath, content, { mode: 0o600 })
    } catch {
      // First-write directory-creation path. Same shape as
      // ghostJournal — duplicated here intentionally; see file header.
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await appendFile(this.filePath, content, { mode: 0o600 })
      } else {
        throw new Error(`dictation-debug append failed for ${this.filePath}`)
      }
    }
  }
}

export class DictationDebugJournalRegistry {
  private journals = new Map<string, DictationDebugJournal>()

  get(debugSessionId: string): DictationDebugJournal {
    let j = this.journals.get(debugSessionId)
    if (!j) {
      j = new DictationDebugJournal(dictationDebugLogPath(debugSessionId))
      this.journals.set(debugSessionId, j)
    }
    return j
  }

  async flushAll(): Promise<void> {
    const drains = [...this.journals.values()].map(j =>
      j.flush().catch(err => {
        console.warn('[dictationJournal] flush error:', err)
      }),
    )
    await Promise.all(drains)
  }

  dispose(debugSessionId: string): void {
    const j = this.journals.get(debugSessionId)
    if (!j) return
    void j.flush().catch(err => {
      console.warn('[dictationJournal] dispose flush error:', err)
    })
    this.journals.delete(debugSessionId)
  }
}

export function dictationDebugLogPath(debugSessionId: string): string {
  return join(
    app.getPath('userData'),
    'dictation-debug',
    `${debugSessionId}.dictation.jsonl`,
  )
}

// Best-effort prune of files older than PRUNE_AFTER_MS. Runs on app
// startup, never throws — a broken prune must not block the app boot.
// Failure here only costs disk; the journal itself still works.
export async function pruneOldDictationDebugLogs(): Promise<void> {
  const dir = join(app.getPath('userData'), 'dictation-debug')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // dir doesn't exist yet — nothing to prune
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const name of entries) {
    if (!name.endsWith('.dictation.jsonl')) continue
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < cutoff) await unlink(full)
    } catch {
      // ignore — file might have been removed concurrently, or the
      // filesystem is misbehaving. We tried.
    }
  }
}
```

- [ ] **Step 2: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/dictationJournal.ts
git commit -m "feat(dictation): add DictationDebugJournal mirroring ghostJournal"
```

---

## Task 3: Wire IPC channel — main side

**Files:**
- Modify: `src/main/ipc/dictation.ts` (accept the new channel, mint debugSessionId path)
- Modify: `src/main/ipc/index.ts` (thread `dictationDebugJournals` in)
- Modify: `src/main/index.ts` (construct registry, flushAll on before-quit, prune on whenReady)

- [ ] **Step 1: Add the `dictation:debug-event` channel handler in `src/main/ipc/dictation.ts`**

Find the existing `registerDictationIpc(): void` declaration. Change its signature so the registry is injected:

```ts
export function registerDictationIpc(deps: {
  dictationDebugJournals: DictationDebugJournalRegistry
}): void {
```

Add the import at the top of the file:

```ts
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
import type { DictationDebugEventInput } from '@preload/api/types.js'
```

Inside `registerDictationIpc`, before the existing `ipcMain.handle('dictation:list-providers', ...)`, add the new channel. We use `ipcMain.on` (not `handle`) because the renderer side is fire-and-forget; we don't need a return value and we don't want to pay the promise round-trip on every chunk:

```ts
// Fire-and-forget journal write. The renderer batches nothing on its
// side — every debug() call site invokes this directly. Main batches
// at 100ms per file (see dictationJournal.ts). The first argument is
// the renderer-minted debugSessionId; subsequent dictations within
// the same app run get distinct ids.
ipcMain.on(
  'dictation:debug-event',
  (_evt, debugSessionId: string, input: DictationDebugEventInput) => {
    if (typeof debugSessionId !== 'string' || !debugSessionId) return
    if (!input || typeof input !== 'object') return
    deps.dictationDebugJournals.get(debugSessionId).append(input)
  },
)
```

- [ ] **Step 2: Thread the dependency through `src/main/ipc/index.ts`**

Find the `registerAllIpc` function signature. Add `dictationDebugJournals: DictationDebugJournalRegistry` to its deps type. Find the `registerDictationIpc()` call (currently called with no args) and replace it with `registerDictationIpc({ dictationDebugJournals: deps.dictationDebugJournals })`.

Add the import:
```ts
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
```

- [ ] **Step 3: Construct + flush + prune in `src/main/index.ts`**

In `src/main/index.ts`, find the line `const ghostJournals = new GhostJournalRegistry()` (around line 56). Add directly below it:

```ts
// Per-dictation-session debug dump registry. Mirrors ghostJournals:
// constructed before IPC handlers register, flushed on before-quit.
// See src/main/dictationJournal.ts for the on-disk shape and the
// rationale for cloning the ghostJournal pattern instead of refactoring.
const dictationDebugJournals = new DictationDebugJournalRegistry()
```

Add the imports near the existing `GhostJournalRegistry` import (around line 13):
```ts
import {
  DictationDebugJournalRegistry,
  pruneOldDictationDebugLogs,
} from '@main/dictationJournal.js'
```

Find `registerAllIpc({ manager, lspManager, ghostJournals, worktreeActivityIndex })` (around line 174) and add the new dep:
```ts
registerAllIpc({ manager, lspManager, ghostJournals, dictationDebugJournals, worktreeActivityIndex })
```

Find `app.on('before-quit', ...)` (around line 190) and add inside the handler, next to `void ghostJournals.flushAll()`:
```ts
// Same rationale as ghostJournals.flushAll — Electron gives us one
// tick before teardown. 100ms queue depth is the worst case.
void dictationDebugJournals.flushAll()
```

Find the `app.whenReady().then(...)` block. Add a non-awaited prune call so a slow prune cannot delay window creation:
```ts
void pruneOldDictationDebugLogs().catch(err => {
  console.warn('[dictation] prune failed (non-fatal):', err)
})
```

- [ ] **Step 4: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Build passes**

Run: `npm run build`
Expected: PASS, no Vite errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/dictation.ts src/main/ipc/index.ts src/main/index.ts
git commit -m "feat(dictation): wire main-side debug-event channel + lifecycle"
```

---

## Task 4: Preload bridge

**Files:**
- Create: `src/preload/api/dictationDebug.ts`
- Modify: `src/preload/api/index.ts` (re-export on `window.api`)

- [ ] **Step 1: Write the bridge**

Create `src/preload/api/dictationDebug.ts`:

```ts
import { ipcRenderer } from 'electron'

import type { DictationDebugEventInput } from '@preload/api/types.js'

// Renderer-side bridge to the per-session dictation debug journal.
// Fire-and-forget by design: we use ipcRenderer.send (not invoke) so
// hot paths — every dataavailable chunk, every 100ms audio-level
// sample — pay no round-trip cost. The main side batches writes at
// 100ms per file. See src/main/dictationJournal.ts for the shape on
// disk and src/main/ipc/dictation.ts for the channel handler.
//
// debugSessionId is minted by the renderer in useComposerDictation at
// recorder construction time. It is NOT the Deepgram stream id; the
// Deepgram id is null during the first ~180ms accidental-tap window,
// and most of the interesting failure events happen there.
export const dictationDebugApi = {
  recordDictationDebugEvent: (
    debugSessionId: string,
    input: DictationDebugEventInput,
  ): void => {
    ipcRenderer.send('dictation:debug-event', debugSessionId, input)
  },
}
```

- [ ] **Step 2: Re-export on `window.api`**

Open `src/preload/api/index.ts`. Find where `dictationApi` is imported and spread into the exported `api` object. Add `dictationDebugApi` next to it.

```bash
grep -n "dictationApi\|dictationDebugApi" src/preload/api/index.ts
```
If `dictationApi` shows up at lines 8 (import) and ~25 (spread), insert the new module in both places. Pattern:

```ts
import { dictationDebugApi } from '@preload/api/dictationDebug.js'
// …
export const api = {
  // …
  ...dictationApi,
  ...dictationDebugApi,
  // …
}
```

- [ ] **Step 3: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Confirm `window.api.recordDictationDebugEvent` is visible to the renderer**

```bash
grep -n "recordDictationDebugEvent" src/preload/api/*.ts src/renderer/src/preload-types.d.ts 2>/dev/null
```
Expected: at least the preload export and (if there's a preload-types.d.ts) the resolved API type. If the renderer has a generated d.ts and the new method is missing, regenerate it (search the codebase for the d.ts generation script; same step as `dictationApi` would have required).

- [ ] **Step 5: Commit**

```bash
git add src/preload/api/dictationDebug.ts src/preload/api/index.ts
git commit -m "feat(dictation): add preload bridge for debug-event channel"
```

---

## Task 5: Instrument main-side events

**Files:**
- Modify: `src/main/ipc/dictation.ts` (emit at session start, every chunk, batch upload, errors)

This task replaces every `console.debug('[dictation:trace]', ...)` and `console.log('[dictation:dump]', ...)` site with a paired emission: keep the existing console line (it's useful in dev) AND emit through the journal so the file captures it.

The wrinkle: main doesn't yet know the renderer's `debugSessionId`. We add it to `dictation:stream-start` params and thread it through `ActiveDictationSession`. We also accept it on `dictation:stream-chunk` (cheap, every chunk already carries the streamId — adding a string is rounding error).

- [ ] **Step 1: Extend the start-stream params shape**

In `src/main/ipc/dictation.ts`, find `ActiveDictationSession`. Add `debugSessionId: string` to it.

Find the `'dictation:stream-start'` handler. Change the params type to include `debugSessionId: string`. Initialize `debugSessionId` in the new session map entry.

Find the `'dictation:stream-chunk'` handler. The renderer doesn't need to send debugSessionId per chunk — we can look it up via the streamId in `activeSessions`. (If the session was canceled, `activeSessions.get` returns undefined and we already return `{ kind: 'ignored' }`. Same path here — no journal emit.)

- [ ] **Step 2: Add a small helper at the top of `registerDictationIpc`**

Place it where `apiKey` etc are scoped — right after the function signature opens:

```ts
const emit = (
  debugSessionId: string | null,
  layer: DictationDebugEventInput['layer'],
  event: string,
  data?: Record<string, unknown>,
) => {
  if (!debugSessionId) return
  deps.dictationDebugJournals.get(debugSessionId).append({ layer, event, data })
}
```

Add the missing import for the helper to type-check:
```ts
import { createHash } from 'node:crypto'
import type { DictationDebugEventInput } from '@preload/api/types.js'
```

Define a one-line SHA8 helper next to the emit helper:
```ts
const sha8 = (buf: Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex').slice(0, 8)
```

- [ ] **Step 3: Emit at every main-side site**

At `'dictation:stream-start'` after `activeSessions.set(id, ...)` and after the existing `console.debug('[dictation:trace]', ...)`, add:

```ts
emit(params.debugSessionId, 'IPC', 'stream-start:accepted', {
  streamId: id,
  provider: params.provider,
  mimeType: params.mimeType ?? null,
  hasApiKey: Boolean(apiKey),
})
```

If the early `'Only Deepgram streaming is wired in cc-shell v1.'` rejection path runs, emit a parallel ERROR event before returning:

```ts
emit(params.debugSessionId, 'ERROR', 'stream-start:rejected', {
  reason: 'non-deepgram-provider',
  provider: params.provider,
})
```

At `'dictation:stream-chunk'` after the existing dump-append (around line 130 in the current file), add:

```ts
emit(session.debugSessionId, 'CHUNK', 'main:received', {
  streamId: params.id,
  chunkIndex: session.chunkCount,        // 1-based after the chunkCount += 1 above
  bytes: chunk.byteLength,
  sha8: sha8(chunk),
  cumulativeBytes: session.audioBytes,
})
```

At `'dictation:stream-stop'` after the existing `console.debug('[dictation:trace]', { phase: 'batch:upload', ... })` (around line 170 in the current file), add:

```ts
emit(session.debugSessionId, 'PROVIDER', 'batch:upload:start', {
  streamId: params.id,
  audioBytes: session.audioBytes,
  chunkCount: session.chunkCount,
  mimeType: session.mimeType ?? null,
})
```

After the awaited `transcribeBatch(...)` call resolves, before returning the success result, add:

```ts
emit(session.debugSessionId, 'PROVIDER', 'batch:upload:ok', {
  streamId: params.id,
  sttMs: Date.now() - startedAt,
  rawTextLen: cleanText.length,
})
emit(session.debugSessionId, 'OUTCOME', 'success', {
  streamId: params.id,
  audioBytes: session.audioBytes,
  chunkCount: session.chunkCount,
  // Truncate at 4KB defensively — even though the journal is local,
  // a runaway transcript shouldn't bloat one line of the JSONL into
  // megabytes. Most dictations are <500 chars; 4KB covers paragraphs.
  text: cleanText.slice(0, 4096),
})
```

In the `'no-speech'` branch (short audio, no chunks, or empty result), emit:
```ts
emit(session.debugSessionId, 'OUTCOME', 'no-speech', {
  streamId: params.id,
  audioBytes: session.audioBytes,
  chunkCount: session.chunkCount,
  reason: session.chunkCount === 0 ? 'no-chunks' : 'short-audio-or-empty-result',
})
```

In the `catch (err)` branch:
```ts
emit(session.debugSessionId, 'ERROR', 'batch:upload:throw', {
  streamId: params.id,
  message: err instanceof Error ? err.message : String(err),
  ms: Date.now() - session.startedAt,
})
emit(session.debugSessionId, 'OUTCOME', 'error', {
  streamId: params.id,
  message: err instanceof Error ? err.message : 'Dictation failed.',
})
```

At `'dictation:stream-cancel'` handler:
```ts
const session = activeSessions.get(params.id)
emit(session?.debugSessionId ?? null, 'OUTCOME', 'cancel', { streamId: params.id })
```
(`emit` is null-safe — no-op if `debugSessionId` is null. Move the activeSessions.delete line AFTER the emit so the lookup works.)

- [ ] **Step 4: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/dictation.ts
git commit -m "feat(dictation): emit MAIN/PROVIDER/CHUNK/OUTCOME debug events"
```

---

## Task 6: Instrument renderer-side lifecycle + chunk events

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts`

This is the biggest task. We mint a `debugSessionId` per recording, emit at every existing `debug(...)` call site, and emit at three new sites (DEVICE enumeration result, every chunk's sha8, and the audio-level sampler — but the sampler is Task 7).

- [ ] **Step 1: Add a tiny utility for SHA8 over an ArrayBuffer in the renderer**

The renderer ships in a Chromium context — `crypto.subtle.digest` exists. Define it near the top of `useComposerDictation.ts`, after `EMPTY_LEVELS`:

```ts
// 8-char SHA-256 prefix over a chunk payload. Used purely as a
// fingerprint for cross-process collision detection: if the same
// chunk hash appears in the renderer's CHUNK:produced event and the
// main's CHUNK:main:received event, we know IPC delivered THIS chunk
// (not a different one with the same byte count). subtle.digest is
// async but tiny — we await it inside the chunk chain, which is
// already serialized, so it adds no extra ordering risk.
async function sha8(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const hex: string[] = []
  const view = new Uint8Array(digest, 0, 4)
  for (const b of view) hex.push(b.toString(16).padStart(2, '0'))
  return hex.join('')
}
```

- [ ] **Step 2: Mint `debugSessionId` at recorder construction**

In the `start` callback, replace the existing block:

```ts
const recording: ActiveRecording = {
  id: null,
  // …
}
```

with one that includes the new field. Add `debugSessionId: string` to the `ActiveRecording` type alias at the top of the file, then initialize it:

```ts
const debugSessionId = crypto.randomUUID()
const recording: ActiveRecording = {
  id: null,
  debugSessionId,
  // … (rest unchanged)
}
```

- [ ] **Step 3: Wrap `debug(...)` so it ALSO emits to the journal**

Find the existing `const debug = useCallback(...)` definition (around line 260). Change it so it both `console.debug`s AND emits to the journal — and add a `layer` argument so each call site can be classified. To keep the call-site diff small, give it an overload-shaped signature with a default layer of `'META'`:

```ts
const debug = useCallback((
  phase: string,
  details: Record<string, unknown> = {},
  layer: DictationDebugLayer = 'META',
) => {
  // eslint-disable-next-line no-console
  console.debug('[dictation:composer]', {
    phase,
    lifecycle: statusRef.current,
    hasRecording: !!activeRef.current,
    ...details,
  })
  // Renderer fire-and-forget. The recording may have ended (active=null)
  // by the time a late callback fires; we still want those tail events
  // in the journal, so we read the debugSessionId from a ref that we
  // set in start() and clear in cleanup().
  const id = debugSessionIdRef.current
  if (!id) return
  window.api.recordDictationDebugEvent(id, {
    layer,
    event: phase,
    data: { lifecycle: statusRef.current, ...details },
  })
}, [])
```

Add the required ref next to other refs at the top of the hook:
```ts
const debugSessionIdRef = useRef<string | null>(null)
```

Set it on `start`:
```ts
debugSessionIdRef.current = debugSessionId
```

Clear it in the unmount cleanup effect and inside `cleanup(...)` AFTER the meter stops AND after the final OUTCOME-emitting code has run (so we don't lose the tail). The safest pattern is to schedule the clear in a microtask:
```ts
queueMicrotask(() => { debugSessionIdRef.current = null })
```

Inside `cleanup` callback, after `stopMeter()`, add the microtask clear.

Add the import for the layer type at the top:
```ts
import type { DictationDebugLayer } from '@preload/api/types'
```

- [ ] **Step 4: Classify each existing `debug(...)` site with the correct layer**

Walk every existing `debug(...)` call and add the third argument. Use this mapping (search-and-replace, line-by-line):

| Call site (phase) | Layer |
|---|---|
| `'start:begin'` | `'META'` |
| `'start:get-user-media:done'` | `'DEVICE'` |
| `'start:recorder-created'` | `'RECORDER'` |
| `'start:error'` | `'ERROR'` |
| `'stream:start:request'` | `'IPC'` |
| `'stream:start:result'` | `'IPC'` |
| `'stream:drain-and-publish'` | `'IPC'` |
| `'stream:start:error'` | `'ERROR'` |
| `'recorder:dataavailable'` | `'RECORDER'` |
| `'recorder:chunk:queued-local'` | `'CHUNK'` |
| `'recorder:chunk:push-ipc'` | `'CHUNK'` |
| `'recorder:chunk:push-error'` | `'ERROR'` |
| `'recorder:error'` | `'ERROR'` |
| `'recorder:start-called'` | `'RECORDER'` |
| `'stop:called'` | `'META'` |
| `'stop:short-press-discard'` | `'META'` |
| `'stop:stopping-recorder'` | `'RECORDER'` |
| `'stop:request-data'` | `'RECORDER'` |
| `'stop:request-data-error'` | `'ERROR'` |
| `'stop:recorder-stop-called'` | `'RECORDER'` |
| `'stop:recorder-stopped'` | `'RECORDER'` |
| `'stop:pending-pushes-settled'` | `'IPC'` |
| `'stop:ipc-result'` | `'IPC'` |
| `'cancel-recording'` | `'META'` |
| `'cleanup'` | `'META'` |

The diff per line is just adding `, 'LAYER'` before the closing `)`.

- [ ] **Step 5: Add a META event at very-start (BEFORE `getUserMedia`)**

In `start`, immediately after `setLifecycleStatus('starting')` and BEFORE `pickAudioConstraints()`, emit:

```ts
debugSessionIdRef.current = debugSessionId
window.api.recordDictationDebugEvent(debugSessionId, {
  layer: 'META',
  event: 'session:created',
  data: {
    provider,
    focused: focusedRef.current,
    baseInputLen: inputRef.current.length,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  },
})
```

(Doing this BEFORE the first `debug(...)` ensures the `session:created` event is the first line in the file.)

- [ ] **Step 6: Add DEVICE events inside `pickAudioConstraints`**

Change `pickAudioConstraints` so it accepts the debugSessionId and emits what it enumerated. To keep the call site simple, factor the enumeration into a small named helper and emit between the enumeration and the return:

```ts
async function pickAudioConstraints(debugSessionId: string): Promise<MediaStreamConstraints> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter(d => d.kind === 'audioinput')
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'DEVICE',
      event: 'enumerate:audioinput',
      data: {
        count: inputs.length,
        labels: inputs.map(d => d.label),
      },
    })
    const builtIn = inputs.find(d => {
      // … (existing matcher unchanged)
    })
    if (builtIn?.deviceId) {
      window.api.recordDictationDebugEvent(debugSessionId, {
        layer: 'DEVICE',
        event: 'select:built-in',
        data: { label: builtIn.label, deviceIdPresent: true },
      })
      return { audio: { deviceId: { exact: builtIn.deviceId } } }
    }
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'DEVICE',
      event: 'select:fallback-default',
      data: { reason: 'no-built-in-match', labels: inputs.map(d => d.label) },
    })
  } catch (err) {
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'ERROR',
      event: 'enumerate:throw',
      data: { message: err instanceof Error ? err.message : String(err) },
    })
  }
  return { audio: true }
}
```

Update the one call site to pass the id:
```ts
const constraints = await pickAudioConstraints(debugSessionId)
```

- [ ] **Step 7: Pass `debugSessionId` to main on stream-start**

Find the `window.api.startDictationStream({...})` call inside `ensureStreamStarted`. Add `debugSessionId`:

```ts
recording.streamStartPromise = window.api.startDictationStream({
  provider,
  debugSessionId: recording.debugSessionId,
  ...(recording.mimeType ? { mimeType: recording.mimeType } : {}),
})
```

Update the preload types: `DictationStartParams` and the IPC signature in `src/preload/api/dictation.ts` to accept `debugSessionId: string`. (This is small; do it as part of this commit.)

- [ ] **Step 8: Emit CHUNK:produced with sha8 inside dataavailable**

Find the `recorder.addEventListener('dataavailable', ...)` block. Inside the `previousChunk.then(async () => { const chunk = await event.data.arrayBuffer() ... })`, immediately after `await event.data.arrayBuffer()`, compute the hash and emit:

```ts
const fingerprint = await sha8(chunk)
window.api.recordDictationDebugEvent(debugSessionId, {
  layer: 'CHUNK',
  event: 'renderer:produced',
  data: {
    chunkIndex,
    bytes: chunk.byteLength,
    sha8: fingerprint,
    streamId: recording.id,                       // null while queueing
    queueLenAtEmit: recording.queuedChunks.length, // for the queue-drain race investigation
  },
})
```

This is the **single most important new event in the whole plan**: it is what lets us prove (or rule out) that the renderer produced a chunk that main never received, or that the order matched the recorder's emission order.

- [ ] **Step 9: Emit TRANSCRIPT events**

Find the existing `window.api.onDictationStreamTranscript(...)` subscription (around line 871). Inside the callback, before the `renderTranscriptPreviewRef.current(recording, event.text)` call, emit:

```ts
window.api.recordDictationDebugEvent(recording.debugSessionId, {
  layer: 'TRANSCRIPT',
  event: event.isFinal ? 'preview:final' : 'preview:interim',
  data: {
    streamId: event.id,
    source: event.source,
    textLen: event.text.length,
    head: event.text.slice(0, 240),
  },
})
```

Wait — `recording.debugSessionId` may not be in scope here because the subscription is at hook-level, not start-level. Read `activeRef.current?.debugSessionId` instead, fall through to `null`, and pass that:

```ts
const debugId = activeRef.current?.debugSessionId
if (debugId) {
  window.api.recordDictationDebugEvent(debugId, { /* … */ })
}
```

In the existing `commitTranscript(recording, result.text)` block at the end of `stop`, emit the committed result:

```ts
window.api.recordDictationDebugEvent(recording.debugSessionId, {
  layer: 'TRANSCRIPT',
  event: 'committed',
  data: {
    streamId: streamId,
    textLen: result.text.length,
    head: result.text.slice(0, 240),
  },
})
```

- [ ] **Step 10: Type-check passes**

Run: `npm run typecheck`
Expected: PASS. If the `DictationStartParams` change breaks anywhere else (e.g., test files), update them.

- [ ] **Step 11: Commit**

```bash
git add \
  src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts \
  src/preload/api/dictation.ts \
  src/main/ipc/dictation.ts
git commit -m "feat(dictation): emit RENDER/DEVICE/CHUNK/TRANSCRIPT debug events"
```

(The `src/main/ipc/dictation.ts` line is just to read `debugSessionId` off the start-stream params now that the renderer is sending it.)

---

## Task 7: Instrument audio-level sampler (the sine-wave data)

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts` (just `startMeter`)

This is the event most directly useful for diagnosing "sine wave doesn't move." If `AUDIO_LEVEL` events come through with the 7 band values pegged at 0, we have proof the AnalyserNode is seeing silence — which says the bug is upstream (mic device, MediaStream tracks, AnalyserNode wiring) rather than downstream (the UI).

- [ ] **Step 1: Throttle to ~10Hz, emit one event per tick**

Find `startMeter`. Inside the `tick` function, after `setLevels(next)` and before `rafRef.current = requestAnimationFrame(tick)`, add throttled emission:

```ts
// Throttle to ~10Hz. requestAnimationFrame fires at 60Hz; 10Hz is
// dense enough to see the level move on a 250ms-per-syllable basis
// and sparse enough that a 30-second utterance lands ~300 events,
// not 1800. The throttle gate is monotonic time — Date.now is fine
// here because nothing in this path depends on sub-millisecond
// precision.
const now = Date.now()
if (now - lastEmitRef.current >= 100) {
  lastEmitRef.current = now
  const id = debugSessionIdRef.current
  if (id) {
    window.api.recordDictationDebugEvent(id, {
      layer: 'AUDIO_LEVEL',
      event: 'sample',
      data: {
        // 3 decimals is enough resolution to see "stuck at 0.000"
        // vs "moving". 6 decimals would be float noise.
        levels: next.map(v => Number(v.toFixed(3))),
        // The peak per-frame is how the UI decides whether the
        // dictation pill is "active." If it's always tiny, the UI
        // shows a dead bar regardless of what mic is connected.
        peak: Number(Math.max(...next).toFixed(3)),
      },
    })
  }
}
```

Add the throttle ref near the other refs at the top of the hook:
```ts
const lastEmitRef = useRef(0)
```

Reset it in `start` (so each session restarts the throttle clock):
```ts
lastEmitRef.current = 0
```

- [ ] **Step 2: Emit one boundary event when the meter starts and another when it stops**

At the top of `startMeter`, after the AudioContext is constructed but before `tick()` is first scheduled:
```ts
const id = debugSessionIdRef.current
if (id) {
  window.api.recordDictationDebugEvent(id, {
    layer: 'AUDIO_LEVEL',
    event: 'meter:start',
    data: {
      sampleRate: ctx.sampleRate,
      fftSize: analyser.fftSize,
      trackLabels: stream.getAudioTracks().map(t => t.label),
      trackMuted: stream.getAudioTracks().map(t => t.muted),
      trackReadyState: stream.getAudioTracks().map(t => t.readyState),
    },
  })
}
```

Inside `stopMeter`, after `setLevels(EMPTY_LEVELS)`:
```ts
const id = debugSessionIdRef.current
if (id) {
  window.api.recordDictationDebugEvent(id, {
    layer: 'AUDIO_LEVEL',
    event: 'meter:stop',
  })
}
```

- [ ] **Step 3: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/useComposerDictation.ts
git commit -m "feat(dictation): emit 10Hz AUDIO_LEVEL samples for sine-wave diagnostics"
```

---

## Task 8: Forward streaming-provider trace events (future-proof for when streaming returns)

**Files:**
- Modify: `src/main/ipc/dictation.ts` (when streaming is wired back in, the onTrace + onTranscript callbacks pipe straight through)

Note: cc-shell currently uses the batch path only. This task adds the forwarding code so that the day the team flips back to streaming (or runs the diagnostic harness against this build), the journal already captures it. Until streaming is wired in `src/main/ipc/dictation.ts`, the new code is dead.

- [ ] **Step 1: Add a small helper that wraps a `createDeepgramStreamingProvider` start with journal forwarding**

This is preparatory and can be expanded the moment streaming is re-enabled. For now, add the helper but leave it unused:

```ts
import type { SpeechTraceEvent } from 'agent-voice-dictation'

function forwardStreamingTrace(
  emit: (
    debugSessionId: string | null,
    layer: DictationDebugEventInput['layer'],
    event: string,
    data?: Record<string, unknown>,
  ) => void,
  debugSessionId: string,
) {
  return {
    onTrace: (event: SpeechTraceEvent) => {
      emit(debugSessionId, 'PROVIDER', 'trace', event as unknown as Record<string, unknown>)
    },
    onTranscript: (event: { id: string; text: string; isFinal: boolean; source: 'final' | 'interim' }) => {
      emit(debugSessionId, 'TRANSCRIPT', event.isFinal ? 'live:final' : 'live:interim', {
        streamId: event.id,
        source: event.source,
        textLen: event.text.length,
        head: event.text.slice(0, 240),
      })
    },
  }
}
```

(If `SpeechTraceEvent` is not exported from the package's public surface, fall back to `unknown` and cast inside the helper. Don't widen the public API just for this.)

- [ ] **Step 2: Add a "streaming future-use" comment block**

Above the new helper, add a thick WHY comment explaining that this is currently dormant and exists so a future flip-back to streaming doesn't need a parallel instrumentation pass.

- [ ] **Step 3: Type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/dictation.ts
git commit -m "feat(dictation): pre-wire streaming-provider trace forwarder"
```

---

## Task 9: Manual verification

No automated tests (per `feedback_no_test_bloat.md`). Verification is end-to-end through the running app.

- [ ] **Step 1: Build + run cc-shell**

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_EXTRA_CA_CERTS \
      SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
npm run dev
```

Wait for the window. Click into a composer, hold Fn, say "the quick brown fox jumps over the lazy dog", release Fn, wait for transcription.

- [ ] **Step 2: Find the JSONL**

```bash
ls -lt "$HOME/Library/Application Support/cc-shell/dictation-debug/" | head -5
```

Expected: one or more `<uuid>.dictation.jsonl` files, the newest mtime within the last minute.

- [ ] **Step 3: Inspect the JSONL**

```bash
SESSION_FILE=$(ls -t "$HOME/Library/Application Support/cc-shell/dictation-debug/"*.dictation.jsonl | head -1)
wc -l "$SESSION_FILE"
head -20 "$SESSION_FILE" | python3 -m json.tool --no-ensure-ascii 2>/dev/null || head -20 "$SESSION_FILE"
```

Expected:
- Line count is >50 for a short utterance (most are AUDIO_LEVEL samples)
- First line is `{"layer":"META","event":"session:created", ...}`
- DEVICE events show `enumerate:audioinput` with all your mic labels, and either `select:built-in` (if on a Mac with built-in) or `select:fallback-default`
- A RECORDER `start-called` event with `timesliceMs: 120`
- An AUDIO_LEVEL `meter:start` event whose `trackLabels` include the mic Chromium granted
- A sequence of AUDIO_LEVEL `sample` events with `levels` arrays
- A sequence of CHUNK `renderer:produced` events with `bytes` and `sha8`
- Matching CHUNK `main:received` events with the same `sha8` values
- A PROVIDER `batch:upload:start` then `batch:upload:ok`
- An OUTCOME `success` event with the transcribed text

- [ ] **Step 4: Reproduce the failure mode the user reported, examine the dump**

Trigger dictation but observe the "no sine wave / no streaming preview" failure mode the user described. Check the JSONL:

- If AUDIO_LEVEL `sample` events show `peak: 0.000` for the entire run → the AnalyserNode is reading silence; the bug is upstream of the meter (mic device or stream wiring). Look at the `trackLabels`/`trackMuted` in the `meter:start` payload to see which device was granted and whether the track was already muted.
- If AUDIO_LEVEL peaks are non-zero but TRANSCRIPT `preview:interim` events never appear → the live-preview path is dead because we're on the batch fallback (which is the current state of `src/main/ipc/dictation.ts:80-92`). The journal confirms it: no PROVIDER trace events, only `batch:upload:ok`.
- If both are missing and the final OUTCOME is still `success` → that's the user's exact reported state. The journal lets us see WHICH chunks made it across IPC and in what order — compare CHUNK `renderer:produced` to CHUNK `main:received` by `chunkIndex` and `sha8` to detect drops or reorders.

- [ ] **Step 5: Document one round of observations in a follow-up doc (not in this PR)**

Append the JSONL filename + a short summary of what it showed to the existing diagnostic README at `vendor/in_progress/dictation-repro/README.md`. No code change in this step — just a paper trail.

- [ ] **Step 6: Final review + push**

If everything looks right:
```bash
git log --oneline -10
```
Expect ~7 commits in this branch (one per task that produced code). Open PR per `feedback_worktree_default.md` workflow:
```bash
gh auth status --hostname github.com
# confirm it's Juliusolsson05; switch if it's Julius-o1
gh pr create --title "feat(dictation): per-session debug dump" --body "$(cat <<'EOF'
## Summary

- Every dictation press now writes a FAT append-only JSONL under `<userData>/dictation-debug/` capturing device pick, recorder lifecycle, every chunk (renderer + main, with sha8 cross-correlation), 10Hz audio-level samples, every IPC round-trip, batch-upload provider trace, and the final outcome.
- The journal lets us diagnose the two symptoms the user has been reporting — silent sine-wave indicator and missing live-streaming preview — without needing to repro them on a debugger.
- Mirrors `ghostJournal` shape: 100ms batched writes, `app.getPath('userData')` location, registry flushed on `before-quit`, 14-day pruning on startup.

## Test plan

- [ ] Hold Fn in a composer, dictate one sentence, release. Verify a `<uuid>.dictation.jsonl` appears under `~/Library/Application Support/cc-shell/dictation-debug/`.
- [ ] Confirm renderer CHUNK `sha8` values match main's CHUNK `sha8` values for the same `chunkIndex`.
- [ ] Confirm AUDIO_LEVEL `sample` events emit at ~10Hz with peaks > 0 when speaking.
- [ ] Confirm OUTCOME `success` lands with the committed transcript text (truncated to 4KB).
- [ ] Confirm files older than 14 days are pruned on next app start.
EOF
)"
```

Per `feedback_no_auto_merge.md`: open the PR, then stop.

---

## Self-Review

Spec coverage: every layer the user named (final transcript, streaming preview, sine wave) has at least one dedicated event type — TRANSCRIPT `committed` for the final, TRANSCRIPT `preview:interim`/`preview:final` for the streaming preview, AUDIO_LEVEL `sample` for the sine wave. The renderer-vs-main chunk-correlation problem (which the diagnostic harness in `vendor/in_progress/dictation-repro/` already reduced to "chunks 0/1 swap → UNPARSABLE_CLIENT_MESSAGE") is covered by paired CHUNK `renderer:produced` + `main:received` events with matching `sha8` fingerprints.

Placeholder scan: none. Every step shows the code to write, the command to run, or the file content to inspect.

Type consistency: `DictationDebugLayer` is defined in Task 1 and used everywhere; `DictationDebugEventInput` in Task 1 + Task 2 + Tasks 4-7; `debugSessionId: string` is added to `DictationStartParams` in Task 6 step 7 and consumed in Task 5 step 1.

One thing this plan deliberately does NOT do: build a viewer for the JSONL. If we end up wanting one we can either pipe it through `jq` ad-hoc, or write a small read-only React route in a follow-up PR. Keeping this PR's scope to "write the file" is the right call — until we know what the file says, we don't know what the viewer should highlight.
