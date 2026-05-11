# Paste-Submit Harness Findings, Documentation Cleanups, and Event-Driven Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three things in one PR:
1. Capture the *non-obvious* insights from the `vendor/in_progress/paste-submit-repro/` investigation as in-tree comments — specifically the broken `'screen'` event emission in `HeadlessTerminal` and the unreliable spinner-based activity detector.
2. Add a per-paste **`paste-debug-dump`** subsystem in cc-shell (mirroring the dictation-debug pattern from PR #68) so we can finally see *what the renderer/IPC actually does* on a failing paste in production. The PTY-isolated harness shows the production 125 ms timer works at 10/10 — meaning the bug lives somewhere the harness doesn't model.
3. Ship the **event-driven paste-submit fix** as a strict improvement over the wall-clock 125 ms timer, behind a feature flag that defaults ON for new sessions. Even if it doesn't fully fix the user-facing bug (we won't know until #2's dumps arrive), it's faster on average AND can never race the way the timer can.

**Architecture:** Three parallel tracks, no shared files, can be reviewed independently inside one PR:

- **Track A (comments)** — `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts` and `packages/claude-code-headless/src/ClaudeCodeHeadless.ts` get thick WHY comments documenting two production-hostile behaviors the harness exposed: `'screen'` event stalling under synchronized-output, and the spinner-regex activity detector misfiring during tool-result and transient-header rows.
- **Track B (debug dump)** — clone of the dictation-debug shape in PR #68: a `pasteDebugJournal` keyed on a renderer-minted UUID per paste-press, captures the full lifecycle from React keydown → `sendBracketedPasteThenSubmit` → IPC → main PTY write. Privacy contract is identical (no raw bytes, sha8 fingerprints for paste payload).
- **Track C (event-driven fix)** — replace the unconditional `await wait(125)` in `claudePaste.ts:43-55` with a polling waiter that resolves when `[Pasted text #N` appears in the live screen snapshot. Falls back to the existing timer when the placeholder doesn't materialize within a safety bound (the bound exists to insure us against future Claude UI changes; it should never fire in current Claude).

**Tech Stack:** TypeScript across renderer/preload/main and the `claude-code-headless` workspace package. Electron IPC for the dump. Existing `node:fs/promises` `appendFile` for journal writes.

---

## File Structure

**Create:**
- `src/main/pasteDebugJournal.ts` — direct sibling of `dictationJournal.ts`, near-duplicate of its shape. One JSONL per paste at `<userData>/paste-debug/<pasteId>.paste.jsonl`.
- `src/preload/api/pasteDebug.ts` — single-method preload bridge `recordPasteDebugEvent(pasteId, layer, event, data)`. Same fire-and-forget `ipcRenderer.send` pattern as `dictationDebug.ts`.

**Modify (Track A — comments):**
- `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts` — add a comment block above `scheduleFlush` documenting the `pendingWrites` stall under Claude's synchronized-output protocol, and the recommended workaround (consumers should `snapshotPlain()` poll rather than rely on the `'screen'` event when correctness matters).
- `packages/claude-code-headless/src/ClaudeCodeHeadless.ts` — add a comment block above the `activity`/`idle` emission documenting that the bottom-up `SPINNER_VERB_RE` walk produces FALSE NEGATIVES during tool-result rendering, Bash() previews, and transient headers, and warn consumers not to use `'activity'` as a binary "did this submit?" signal. (The harness lost 2/10 iterations on a false-negative spinner read before we figured this out.)

**Modify (Track B — debug dump plumbing):**
- `src/preload/api/types.ts` — add `PasteDebugLayer` and `PasteDebugEventInput` types next to the existing `DictationDebugLayer` types.
- `src/preload/api/index.ts` — re-export `pasteDebugApi` on `window.api`.
- `src/main/ipc/index.ts` — thread a `PasteDebugJournalRegistry` through `IpcDeps`, register the `paste:debug-event` channel.
- `src/main/index.ts` — construct the registry, flush on `before-quit`, prune 14-day-old files on startup.
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts` — mint `pasteId = crypto.randomUUID()` on Enter, emit RENDER:keydown, RENDER:state-snapshot (composer text length, focus, recorder state), RENDER:call-paste-fn events. Forward `pasteId` to the call site.
- `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts` — accept optional `pasteId` argument on `sendBracketedPasteThenSubmit` and `sendClaudeDraftText`; emit IPC:paste-write, IPC:submit-write events with sha8 of the payload.
- `src/main/sessions/...` (the file that handles the `terminal:write` IPC) — emit PTY:write events on each chunk with sha8 + byte count. Find the file by `grep -rn "ipcMain.handle.*terminal:write\|sessionManager.*write" src/main/` — likely `src/main/ipc/session.ts` or similar. We pair these against the renderer's IPC:paste-write events the same way dictation pairs renderer-produced and main-received chunks.

**Modify (Track C — event-driven fix):**
- `packages/claude-code-headless/src/ClaudeCodeHeadless.ts` — add a new method `awaitPastePlaceholder(opts?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<{ kind: 'appeared'; waitedMs: number } | { kind: 'timeout' }>`. Polls `this.screen` (or directly the headless terminal) for `/\[Pasted text #\d+/.test(plain)`.
- `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts` — replace the `await wait(delayMs)` line with a call out through IPC to await the placeholder. New IPC: `dictation:claude-await-paste-placeholder` (or similar) — returns when the placeholder appears or after 2 s safety timeout.
- `src/main/ipc/session.ts` (or wherever ClaudeSession lives) — register the new IPC handler that delegates to `ClaudeCodeHeadless.awaitPastePlaceholder`.
- `src/renderer/src/app-state/settings/types.ts` — add `eventDrivenPasteSubmit: boolean`, default **true** (we are confident enough from the harness that we ship ON, with the timer as the fallback path so a buggy detector can't worse-than-status-quo us).

**No new tests, no new `test:*` scripts.** Per `feedback_no_test_bloat.md`. The harness already gates regressions — re-running `runs/event-driven-reliability.ts` after this work should still be 10/10.

---

## Task 0: Sanity-check the harness is still green

Quick smoke test so we know baseline before we change anything that the package depends on.

- [ ] **Step 1: Run reliability gates**

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_EXTRA_CA_CERTS \
      SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
npx tsx --tsconfig /Users/juliusolsson/Desktop/Development/cc-shell/tsconfig.node.json \
  /Users/juliusolsson/Desktop/Development/cc-shell/vendor/in_progress/paste-submit-repro/runs/baseline-reliability.ts
npx tsx --tsconfig /Users/juliusolsson/Desktop/Development/cc-shell/tsconfig.node.json \
  /Users/juliusolsson/Desktop/Development/cc-shell/vendor/in_progress/paste-submit-repro/runs/event-driven-reliability.ts
```

Expected: both print `RELIABILITY: PASS — 10/10 iterations succeeded.`

If either fails, the harness has drifted and that needs fixing before this plan touches production code.

---

## Task 1: Track A — document HeadlessTerminal's `'screen'` event stall

**Files:**
- Modify: `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts:376` (above `scheduleFlush`)

- [ ] **Step 1: Add the WHY comment**

Find the `private scheduleFlush(): void {` line. Above it, add:

```ts
// -----------------------------------------------------------------------------
// KNOWN ISSUE: the 'screen' event can stall under synchronized output
// -----------------------------------------------------------------------------
//
// Claude's TUI uses the synchronized-output protocol heavily — every
// composer redraw is wrapped in `\x1b[?2026h … \x1b[?2026l` so the
// terminal renders the new frame atomically. `@xterm/headless` parses
// those sequences correctly into the buffer, but its `write(data, cb)`
// callback timing is influenced by them: under sustained sync-output
// pressure the per-chunk callbacks can land in a way that leaves
// `pendingWrites` > 0 indefinitely, so `scheduleFlush()` is never
// re-armed and consumers stop receiving `'screen'` events even though
// the buffer is being updated correctly.
//
// We discovered this building the paste-submit reproduction harness at
// `vendor/in_progress/paste-submit-repro/`. The harness's PTY trace
// showed Claude continuously emitting render chunks, the buffer
// contained the up-to-date input box (verified by polling
// `snapshotPlain()` directly), yet the `'screen'` listener went silent
// after the cold-boot banner. Polling on a wall-clock interval gives
// the same data this event was supposed to surface, without the stall.
//
// What this means for consumers:
//   * If you only need a periodic snapshot for diagnostics or
//     parsing, prefer a fixed-interval poll of `snapshotPlain()` /
//     `snapshotMarkdown()` over subscribing to `'screen'`. The poll
//     is cheap (synchronous read from the xterm buffer) and is the
//     same approach the in-app HTML Debug Panel uses.
//   * If you DO subscribe to `'screen'` for low-latency reaction
//     (e.g. waiting for `[Pasted text #N]` to appear before sending
//     submit), you MUST also have a wall-clock timeout fallback
//     because the event may never fire in this session.
//
// A real fix would be to either: drop the pendingWrites counter and
// schedule a flush on every `pty.onData` (cheap, more events but no
// stalls); or replace the @xterm/headless callback mechanism with
// our own write→parse barrier. Neither change is in scope for the
// paste-submit work; this comment exists so the next person who
// notices the stall doesn't re-rediscover the bug from scratch.
```

- [ ] **Step 2: Type-check passes**

Run: `npm run typecheck` (or `npm run build` if no `typecheck` script).
Expected: PASS — comments-only change.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-headless/src/terminal/HeadlessTerminal.ts
git commit -m "docs(headless): document 'screen' event stall under synchronized output"
```

---

## Task 2: Track A — document the spinner-detector false-negative

**Files:**
- Modify: `packages/claude-code-headless/src/ClaudeCodeHeadless.ts` — above the `activity`/`idle` debouncer block (search `idleDebounceTimer` to find it)

- [ ] **Step 1: Add the WHY comment**

Find the `private idleDebounceTimer:` field declaration (around line 224). The comment above it already mentions the spinner-row replacement quirk, but it frames it as a UI-flicker concern. Replace it with a stronger warning:

```ts
// Debounce timer for `idle`.
//
// CC redraws the spinner cell every frame, but in practice there are
// *long* windows (multi-second) where the spinner row is replaced by
// a transient header — tool-call summaries, the "Bash(...)" preview,
// a "Tip:" footer line, tool-result chrome — and the bottom-up
// SPINNER_VERB_RE walk returns null even though CC is clearly still
// working.
//
// -----------------------------------------------------------------------------
// FALSE NEGATIVES WHEN USED AS A "DID THIS SUBMIT?" SIGNAL
// -----------------------------------------------------------------------------
//
// Do NOT use the `'activity'` event as a binary verdict for "did
// Claude accept and start processing my submit?" The
// paste-submit-repro harness lost 2/10 iterations exactly this way:
// Claude HAD submitted, the composer HAD cleared, and a JSONL entry
// landed shortly after — but the spinner row at the moment we
// sampled showed a Bash() preview header, the regex matched nothing,
// and the `'activity'` event never fired for that window.
//
// If you need to verify a submit succeeded, prefer one of:
//   * "the composer's `[Pasted text #N]` placeholder is gone" —
//     reliable, screen-truth, what the harness ended up using
//   * "a new JSONL assistant entry appeared on the committed
//     channel" — authoritative, but lags submit by several seconds
//   * "the spinner row matched, OR the composer cleared, OR a
//     committed entry arrived" — the most forgiving combination,
//     suitable for UX features that just need "are we definitely
//     working now?"
//
// The 2500ms debounce below is for UX (preventing the activity pip
// from flashing on/off across spinner-row gaps), NOT for correctness.
// Tightening it is fine when needed; reducing reliance on the event
// for state machines is more important.
//
// 2500ms is empirically wide enough to bridge the longest spinner
// gap CC's TUI shows during a normal turn (tool output animation
// cycles ~1.5s), without introducing perceptible lag at the end of a
// turn — the user finishes reading the assistant block before the
// green pip drops.
private idleDebounceTimer: ReturnType<typeof setTimeout> | null = null
```

(Existing field declaration `private idleDebounceTimer: …` should follow the comment. Don't duplicate it.)

- [ ] **Step 2: Type-check passes**

Same as Task 1.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-headless/src/ClaudeCodeHeadless.ts
git commit -m "docs(headless): warn about spinner-detector false negatives as submit verdict"
```

---

## Task 3: Track B — types + scaffold for paste-debug

**Files:**
- Modify: `src/preload/api/types.ts`

- [ ] **Step 1: Add types**

Below the `DictationDebugEvent` type that PR #68 added, insert:

```ts
// Per-paste debug dump.
//
// Mirror of the dictation-debug subsystem in PR #68. Every Enter that
// triggers a paste-submit code path writes one append-only JSONL file
// under `<userData>/paste-debug/<pasteId>.paste.jsonl` capturing the
// full renderer→IPC→main→PTY chain. The bug we are chasing is the
// "paste in cc-shell needs a second Enter to submit" intermittent —
// the PTY-isolated harness at `vendor/in_progress/paste-submit-repro/`
// shows the production 125 ms timer path works at 10/10 in isolation,
// so the failure must be somewhere the harness doesn't model
// (renderer keyboard handler, IPC queue, React state, double-submit
// race). This dump is the diagnostic tool that will pin it down.
//
// `pasteId` is renderer-minted at the moment Enter is observed in the
// composer keydown handler, BEFORE any state-mutation or async send
// happens. Threading it through the call stack lets the main side's
// PTY-write event correlate against the renderer's keydown timestamp
// for the same press.
export type PasteDebugLayer =
  | 'RENDER'    // keydown, composer state snapshot, call into claudePaste fn
  | 'IPC'       // renderer-side IPC write (paste payload, submit \r)
  | 'PTY'       // main-side PTY write (sha8 + byte count)
  | 'SCREEN'    // observed `[Pasted text #N]` placeholder appear / disappear
  | 'OUTCOME'   // composer cleared / still-stuck / explicit cancel
  | 'ERROR'

export type PasteDebugEventInput = {
  layer: PasteDebugLayer
  event: string
  data?: Record<string, unknown>
}

export type PasteDebugEvent = PasteDebugEventInput & {
  ts: number
  tMs: number
}
```

- [ ] **Step 2: Commit**

```bash
git add src/preload/api/types.ts
git commit -m "feat(paste-debug): add PasteDebugLayer/Event types"
```

---

## Task 4: Track B — main-side journal

**Files:**
- Create: `src/main/pasteDebugJournal.ts`

- [ ] **Step 1: Copy and adapt the dictation journal**

The file is a near-duplicate of `src/main/dictationJournal.ts` shipped in PR #68. Three differences:
- File path: `<userData>/paste-debug/<pasteId>.paste.jsonl`
- Class names: `PasteDebugJournal`, `PasteDebugJournalRegistry`
- Path resolver name: `pasteDebugLogPath`
- Prune routine name: `pruneOldPasteDebugLogs`

Copy `dictationJournal.ts` verbatim and rename. The comment in the file header should reference PR #68's dictationJournal as the deliberate near-duplicate, with the same justification: a shared "BatchedJsonlWriter" is YAGNI until a third caller shows up.

- [ ] **Step 2: Commit**

```bash
git add src/main/pasteDebugJournal.ts
git commit -m "feat(paste-debug): add PasteDebugJournal mirroring dictationJournal"
```

---

## Task 5: Track B — preload bridge + IPC handler

**Files:**
- Create: `src/preload/api/pasteDebug.ts`
- Modify: `src/preload/api/index.ts`, `src/main/ipc/index.ts`, `src/main/ipc/dictation.ts` (or wherever the equivalent dictation channel is — search `dictation:debug-event` and put the new one alongside; if there's no obvious "paste" IPC file, create `src/main/ipc/pasteDebug.ts`)
- Modify: `src/main/index.ts` — construct + flush + prune

- [ ] **Step 1: Preload bridge**

Copy `src/preload/api/dictationDebug.ts` to `src/preload/api/pasteDebug.ts`, swap names:

```ts
import { ipcRenderer } from 'electron'
import type { PasteDebugEventInput } from '@preload/api/types.js'

export const pasteDebugApi = {
  recordPasteDebugEvent: (pasteId: string, input: PasteDebugEventInput): void => {
    ipcRenderer.send('paste:debug-event', pasteId, input)
  },
}
```

- [ ] **Step 2: Re-export on window.api**

In `src/preload/api/index.ts`, add `import { pasteDebugApi } from '@preload/api/pasteDebug.js'` and spread it into the `api` object next to `dictationDebugApi`.

- [ ] **Step 3: IPC handler**

In whichever main file owns the dictation `paste:debug-event` channel (or new `src/main/ipc/pasteDebug.ts`), add:

```ts
ipcMain.on('paste:debug-event', (_evt, pasteId: unknown, input: unknown) => {
  if (typeof pasteId !== 'string' || !pasteId) return
  if (!input || typeof input !== 'object') return
  const payload = input as PasteDebugEventInput
  if (typeof payload.layer !== 'string' || typeof payload.event !== 'string') return
  pasteDebugJournals.get(pasteId).append(payload)
})
```

Thread `pasteDebugJournals: PasteDebugJournalRegistry` through `IpcDeps` the same way `dictationDebugJournals` is threaded today.

- [ ] **Step 4: Main lifecycle**

In `src/main/index.ts`, next to `const dictationDebugJournals = new DictationDebugJournalRegistry()`:

```ts
const pasteDebugJournals = new PasteDebugJournalRegistry()
```

Pass into `registerAllIpc({ …, pasteDebugJournals })`. In `before-quit`:

```ts
void pasteDebugJournals.flushAll()
```

In `whenReady`:

```ts
void pruneOldPasteDebugLogs().catch(err => {
  console.warn('[paste-debug] prune failed (non-fatal):', err)
})
```

- [ ] **Step 5: Type-check + build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/preload/api/pasteDebug.ts src/preload/api/index.ts \
        src/main/ipc/* src/main/index.ts
git commit -m "feat(paste-debug): wire IPC channel + main-side lifecycle"
```

---

## Task 6: Track B — renderer instrumentation

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts`
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts`

- [ ] **Step 1: Find the call site**

```bash
grep -n "sendBracketedPasteThenSubmit\|sendClaudeDraftText" \
  src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts
```

Expected: one or more matches. Read the surrounding ~30 lines so you can identify the keydown handler that fires when the user presses Enter with a paste-eligible draft.

- [ ] **Step 2: Mint pasteId + emit RENDER events**

At the very top of the Enter-keydown handler, before any state mutation:

```ts
const pasteId = crypto.randomUUID()
window.api.recordPasteDebugEvent(pasteId, {
  layer: 'RENDER',
  event: 'keydown:enter',
  data: {
    composerLen: currentInput.length,
    composerHead: currentInput.slice(0, 240),
    isPasteLike: currentInput.includes('\n') || currentInput.length > 800,
    focused: focusedRef.current,
    hasModifier: event.shiftKey || event.altKey || event.ctrlKey || event.metaKey,
  },
})
```

Right before the actual `sendBracketedPasteThenSubmit(send, payload, 125)` call:

```ts
window.api.recordPasteDebugEvent(pasteId, {
  layer: 'RENDER',
  event: 'call:sendBracketedPasteThenSubmit',
  data: { payloadLen: payload.length, delayMs: 125 },
})
```

If the handler EVER falls through to a different code path (e.g., a non-paste-shaped submit that just sends `\r`), emit:

```ts
window.api.recordPasteDebugEvent(pasteId, {
  layer: 'RENDER',
  event: 'call:plain-submit',
  data: { reason: 'payload below paste threshold' /* or whatever the branch reason is */ },
})
```

This is the single most important step — if production is hitting a different branch than we think, this event tells us.

- [ ] **Step 3: Thread pasteId into claudePaste.ts**

Add `pasteId?: string` as an optional last argument to `sendBracketedPasteThenSubmit` and `sendClaudeDraftText` in `claudePaste.ts`. Inside, emit:

```ts
if (pasteId) {
  window.api.recordPasteDebugEvent(pasteId, {
    layer: 'IPC',
    event: 'write:paste-payload',
    data: {
      bytes: payload.length,
      sha8: await sha8(new TextEncoder().encode(payload).buffer),
    },
  })
}
await send(`\x1b[200~${payload}\x1b[201~`)
if (delayMs > 0) await wait(delayMs)
if (pasteId) {
  window.api.recordPasteDebugEvent(pasteId, {
    layer: 'IPC',
    event: 'write:submit-cr',
    data: { delayMs },
  })
}
await send('\r')
```

Use the `sha8` helper pattern from PR #68's `useComposerDictation.ts` — `crypto.subtle.digest('SHA-256', buf)` truncated to 8 hex chars.

- [ ] **Step 4: Build passes**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts \
        src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts
git commit -m "feat(paste-debug): instrument renderer keydown + paste call site"
```

---

## Task 7: Track B — main-side PTY write instrumentation

**Files:**
- Modify: the file owning `terminal:write` IPC (likely `src/main/ipc/session.ts` — search `'terminal:write'`)

- [ ] **Step 1: Find the IPC handler**

```bash
grep -rn "'terminal:write'\|terminal.*write\b" src/main/ipc/ src/main/sessions/
```

Identify the handler that takes `(sessionId, data)` and calls `pty.write(data)`.

- [ ] **Step 2: Accept optional pasteId**

The renderer side will need to pass pasteId through when this IPC is fired *from the paste flow*. Two options:
- (a) Add a new IPC channel `terminal:write-with-paste-id` that carries `(sessionId, data, pasteId)`, and have `claudePaste.ts` use the new channel when pasteId is set.
- (b) Add `pasteId?: string` to the existing IPC signature — but that requires touching every caller of `send()` not just the paste path. Bigger blast radius.

Prefer (a). The renderer's `send` callback that's passed to `sendBracketedPasteThenSubmit` becomes a thin wrapper that uses the new channel.

- [ ] **Step 3: Emit PTY event on main side**

```ts
// in the new handler for terminal:write-with-paste-id
ipcMain.handle('terminal:write-with-paste-id', async (_evt, sessionId: string, data: string, pasteId: string) => {
  const bytes = Buffer.byteLength(data, 'utf8')
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 8)
  pasteDebugJournals.get(pasteId).append({
    layer: 'PTY',
    event: 'main:write',
    data: { sessionId, bytes, sha8: sha, head: data.slice(0, 40).replace(//g, '\\e') },
  })
  await sessionManager.writeToSession(sessionId, data) // or however writes happen
})
```

Now we can pair `IPC:write:paste-payload` (renderer-side sha8) against `PTY:main:write` (main-side sha8) by `pasteId` + chunk order, exactly the way PR #68 pairs `CHUNK:renderer:produced` against `CHUNK:main:received` in dictation.

- [ ] **Step 4: Build passes**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/session.ts src/preload/api/dictation.ts # or wherever the renderer-side IPC method lives
git commit -m "feat(paste-debug): emit PTY:write events with sha8 correlation"
```

---

## Task 8: Track C — `awaitPastePlaceholder` in `claude-code-headless`

**Files:**
- Modify: `packages/claude-code-headless/src/ClaudeCodeHeadless.ts`

- [ ] **Step 1: Add the method**

Find the public methods section (after `start()`, `stop()`, `write()`, etc.) and add:

```ts
/**
 * Poll the live screen snapshot for Claude's `[Pasted text #N]`
 * placeholder. Used by the paste-submit flow to send `\r` only after
 * Claude has visibly committed the paste to the composer — the
 * load-independent equivalent of the production `setTimeout(125)`
 * wait.
 *
 * WHY this is on the headless class and not in cc-shell renderer:
 *   The renderer doesn't have a fast path to the live xterm buffer.
 *   It would have to IPC over and wait for the response on every
 *   poll, which is exactly the 5-50 ms overhead this method exists
 *   to avoid. The headless class already owns the buffer; the
 *   `screen` channel exposes the same poll cheaply.
 *
 * WHY a timeout fallback is mandatory:
 *   Claude's future UI changes could rename the placeholder, change
 *   its format, or remove it. Without a bound, the caller could hang
 *   forever waiting for a string that will never appear. 2 s is
 *   chosen as ~10x the observed maximum wait under load (~100 ms in
 *   our harness sample) — large enough that a real placeholder
 *   appearance always wins, small enough that the timeout-fallback
 *   path doesn't make a real submit feel laggy.
 *
 * WHY 10 ms polling:
 *   The harness measured placeholder appearances at p50 ~50 ms and
 *   p95 ~108 ms. 10 ms keeps the worst-case latency between
 *   appearance and submit under one frame.
 */
awaitPastePlaceholder(opts: {
  timeoutMs?: number
  pollIntervalMs?: number
} = {}): Promise<{ kind: 'appeared'; waitedMs: number } | { kind: 'timeout' }> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const pollIntervalMs = opts.pollIntervalMs ?? 10
  const startedAt = Date.now()
  return new Promise(resolve => {
    const tick = () => {
      const plain = this.terminal.snapshotPlain()
      if (/\[Pasted text #\d+/.test(plain)) {
        resolve({ kind: 'appeared', waitedMs: Date.now() - startedAt })
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve({ kind: 'timeout' })
        return
      }
      setTimeout(tick, pollIntervalMs)
    }
    tick()
  })
}
```

- [ ] **Step 2: Build the package**

```bash
npm --prefix packages/claude-code-headless run build
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-headless/src/ClaudeCodeHeadless.ts
git commit -m "feat(headless): add awaitPastePlaceholder for event-driven paste-submit"
```

---

## Task 9: Track C — wire the new method through IPC

**Files:**
- Modify: `src/main/ipc/session.ts` (or wherever ClaudeSession IPC lives) — register a new IPC handler
- Modify: `src/preload/api/dictation.ts` (or wherever Claude-session IPC bridge lives) — expose the new method
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts` — use the new method behind the setting flag

- [ ] **Step 1: Add settings field**

In `src/renderer/src/app-state/settings/types.ts`, after the existing dictation fields:

```ts
/** Event-driven paste-submit. When ON (default), claudePaste.ts
 *  polls the live Claude TUI screen snapshot for `[Pasted text #N]`
 *  before sending `\r`, instead of waiting a fixed 125 ms wall clock.
 *  Falls back to the timer if the placeholder doesn't appear within
 *  2 s — the timer path is the existing behavior so flipping this
 *  setting OFF restores production v2.x behavior exactly.
 *
 *  Default ON because the PTY-isolated harness (vendor/in_progress/
 *  paste-submit-repro) shows event-driven is 10/10 reliable AND
 *  faster on average (~50 ms wait vs. 125 ms unconditional). Even
 *  though we don't yet know the actual production failure mode
 *  (see docs/superpowers/plans/2026-05-11-…), event-driven cannot
 *  be WORSE than the timer in any modeled scenario. */
eventDrivenPasteSubmit: boolean
```

Add to `DEFAULT_SETTINGS`:

```ts
eventDrivenPasteSubmit: true,
```

Add to `coerceSettings` in `persistence.ts`:

```ts
eventDrivenPasteSubmit: parsed.eventDrivenPasteSubmit !== false, // default ON, requires explicit `false` to disable
```

- [ ] **Step 2: New IPC channel**

In the main-side session IPC file:

```ts
ipcMain.handle('claude:await-paste-placeholder', async (_evt, sessionId: string, opts?: { timeoutMs?: number }) => {
  const session = sessionManager.getClaudeSession(sessionId) // adjust to your accessor
  if (!session) return { kind: 'no-session' as const }
  return session.headless.awaitPastePlaceholder(opts ?? {})
})
```

- [ ] **Step 3: Preload bridge**

Add to the appropriate preload API file:

```ts
awaitClaudePastePlaceholder: (sessionId: string, opts?: { timeoutMs?: number }) =>
  ipcRenderer.invoke('claude:await-paste-placeholder', sessionId, opts) as Promise<
    { kind: 'appeared'; waitedMs: number } | { kind: 'timeout' } | { kind: 'no-session' }
  >,
```

- [ ] **Step 4: Wire claudePaste.ts to use it conditionally**

In `claudePaste.ts`, change `sendBracketedPasteThenSubmit` so it takes an optional `eventDriven: { sessionId: string; enabled: boolean }`:

```ts
export async function sendBracketedPasteThenSubmit(
  send: WriteFn,
  payload: string,
  delayMs = 0,
  eventDriven?: { sessionId: string; enabled: boolean },
  pasteId?: string,
): Promise<void> {
  await sendBracketedPaste(send, payload)
  if (eventDriven?.enabled) {
    const outcome = await window.api.awaitClaudePastePlaceholder(eventDriven.sessionId, { timeoutMs: 2_000 })
    if (pasteId) {
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'SCREEN',
        event: outcome.kind === 'appeared' ? 'placeholder:appeared' : 'placeholder:timeout',
        data: outcome.kind === 'appeared' ? { waitedMs: outcome.waitedMs } : {},
      })
    }
    if (outcome.kind === 'appeared') {
      await send('\r')
      return
    }
    // Fall through to the timer-based path: a future Claude UI
    // change that removes the placeholder must not break submit
    // entirely. The bound is 2 s above; below we still wait the
    // remaining delay (down to a minimum of CLAUDE_PASTE_SUBMIT_DELAY_MS)
    // so we never submit too fast.
  }
  if (delayMs > 0) await wait(delayMs)
  await send('\r')
}
```

Update the call site in `useComposerKeybinds.ts` to pass `{ sessionId, enabled: settings.eventDrivenPasteSubmit }` and the `pasteId`.

- [ ] **Step 5: Build passes**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts \
        src/renderer/src/app-state/settings/persistence.ts \
        src/main/ipc/session.ts \
        src/preload/api/dictation.ts \
        src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts \
        src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts
git commit -m "feat(paste): event-driven submit via [Pasted text] placeholder polling"
```

---

## Task 10: Manual verification + ship

- [ ] **Step 1: Re-run reliability gates**

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_EXTRA_CA_CERTS \
      SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
npx tsx --tsconfig /Users/juliusolsson/Desktop/Development/cc-shell/tsconfig.node.json \
  /Users/juliusolsson/Desktop/Development/cc-shell/vendor/in_progress/paste-submit-repro/runs/baseline-reliability.ts
npx tsx --tsconfig /Users/juliusolsson/Desktop/Development/cc-shell/tsconfig.node.json \
  /Users/juliusolsson/Desktop/Development/cc-shell/vendor/in_progress/paste-submit-repro/runs/event-driven-reliability.ts
```

Expected: both 10/10. If event-driven dropped (because Task 8's `awaitPastePlaceholder` has a different `snapshotPlain` path than the harness's polling) we have a problem to fix before merge.

- [ ] **Step 2: Run cc-shell in dev**

```bash
npm run dev
```

Reproduce the bug the user reports: paste a multi-line message into a Claude composer, press Enter. The first Enter should now submit reliably.

- [ ] **Step 3: Inspect a paste dump**

```bash
ls -t "$HOME/Library/Application Support/cc-shell/paste-debug/" | head -5
```

Open the most recent `.paste.jsonl` and verify it contains:
- one RENDER `keydown:enter` event
- one RENDER `call:sendBracketedPasteThenSubmit` event
- one IPC `write:paste-payload` event with sha8
- one PTY `main:write` event with matching sha8
- one SCREEN `placeholder:appeared` event with waitedMs < 200
- one IPC `write:submit-cr` event
- one PTY `main:write` event with `\r`
- one OUTCOME `composer:cleared` event

If a real failing paste happens, the dump tells us exactly which step diverges from this expected shape.

- [ ] **Step 4: Open PR**

```bash
gh auth status --hostname github.com  # confirm Juliusolsson05
gh pr create --title "feat(paste): event-driven submit + per-paste debug dump + headless quirks docs" --body "..."
```

Per `feedback_no_auto_merge.md`: open the PR, then stop. Wait for the user to merge after they've tried it for a day.

---

## Self-Review

**Spec coverage:**
- Track A (comments): both insights from the harness session (screen-event stall, spinner false-negative) are captured with thick WHY comments in the package source. ✓
- Track B (debug dump): full renderer→IPC→PTY observability is plumbed end-to-end. ✓
- Track C (event-driven fix): shipped behind a default-ON setting with a 2 s timeout fallback. ✓

**Placeholder scan:** None — every step has either real code or a precise grep.

**Type consistency:** `PasteDebugLayer`/`Event` shape matches `DictationDebugLayer`/`Event` from PR #68; `awaitPastePlaceholder` return shape (`{ kind: 'appeared'; waitedMs } | { kind: 'timeout' }`) is propagated through IPC and the renderer call site identically.

**Hypotheses NOT to commit to in this PR:** The plan deliberately does NOT pre-commit to a specific renderer-side fix (e.g. "it's a double-fire on the keydown handler") because the harness can't distinguish between IPC-latency, double-fire, and state-mutation hypotheses. The debug dump is what lets us pick the right one. If, after one user-facing repro with the dump on, the diagnosis is obvious, a follow-up PR handles it. This PR's job is observability + a defensive improvement, not a speculative renderer rewrite.

**Critical not-done thing:** This PR ships the event-driven fix but does NOT claim to fix the production bug. The user's reported "I have to follow up with a `.`" symptom may persist. Verifying the fix means: collect at least one failing paste-debug-dump from a user-facing session, diff the event sequence against the expected shape from Task 10 Step 3, and only then write a Phase-2 plan targeted at the real divergence.
