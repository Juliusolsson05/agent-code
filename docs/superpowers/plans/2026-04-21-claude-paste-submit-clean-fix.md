# Fixing Claude multi-line paste submit, cleanly, for good

This plan replaces the wall-clock `CLAUDE_PASTE_SUBMIT_DELAY_MS` timer (`TileLeaf.tsx:45`, and the same pattern duplicated in `ClaudeCodeHeadless.sendPrompt`, `ClaudeCodeHeadless.ts:1100`) with an event-driven submit that observes Claude's own state before sending Enter.

The timer is not tunable. It's wrong *in kind*, not in value — the thing we want to wait for isn't a duration, it's a condition.

## 1. What the bug actually is

Claude Code collapses long pastes inside its own Ink composer by accumulating every `isPasted=true` keypress chunk into a buffer, then flushing on a 100ms debounce (`claude-code-src/full/hooks/usePasteHandler.ts:15` `PASTE_COMPLETION_TIMEOUT_MS = 100`). Inside that debounce window, **every subsequent keystroke is treated as more paste content** — not because of the bracketed-paste mode flag, but because of a synchronous `pastePendingRef.current` guard (lines 48-53, 253-258).

If we write `\x1b[200~<text>\x1b[201~\r` in one PTY chunk:
1. The tokenizer emits `PASTE_START`, a text token, `PASTE_END` — each is an `isPasted=true` key.
2. `pastePendingRef.current` is set true, the 100ms debounce starts.
3. The `\r` that follows is read from the same stdin chunk and dispatched via `wrappedOnInput` — which sees `pastePendingRef.current === true` and absorbs `\r` into the paste buffer as literal text.
4. 100ms later the debounce fires, `onPaste(pastedText)` gets called with `\r` at the end of the text.
5. `onTextPaste` normalizes `\r` → `\n` (`PromptInput.tsx:1204`) and shoves the whole thing into the composer — possibly as a `[Pasted text #N +X lines]` placeholder.
6. **No submit happened.** The composer is sitting there with the paste loaded. The user has to press Enter *again*.

The current workaround (`TileLeaf.tsx:34-45`) is: send paste, wait 125ms (> 100ms debounce), then send `\r`. Intent is to let the debounce fire so `pastePendingRef.current` clears before `\r` arrives.

## 2. Why 125ms doesn't always work

The 100ms debounce is a *minimum* not a *maximum*. The window runs from "last paste chunk arrived" to "100ms of quiet elapsed." Real-world factors that push the clear past our 125ms wait:

- **Slow renderer**: Ink is a React renderer on top of a VT parser. When the feed has grown large or the session is mid-stream, a setTimeout scheduled on the paste debounce can be delayed by React reconciliation + Ink repaint. We have observed Claude's event loop blocked >200ms under load.
- **PTY buffering latency**: Our 125ms starts when Node's write callback returns. The bytes still have to traverse the pty master/slave queue, Claude's readable stream, the parse-keypress tokenizer, and land in `wrappedOnInput`. Under OS pressure this is nondeterministic.
- **Nested paste re-arming**: If our paste was large enough that Node split it into multiple readable chunks, each chunk re-arms the timer. Our 125ms count starts from the first write, but the timer restarted on the last chunk. Under load the timer base drifts.
- **Paste-chunk fragmentation bug**: `tokenize.ts:214` has a known case where `PASTE_END` is swallowed by the X10 mouse handler; the paste never terminates. We'd wait forever. The tokenize comment explicitly calls this out as "Known limitation".

The timer works most of the time. When it fails, the user's prompt silently becomes a placeholder and they think something broke. This is the "goofy timed enter that never ends up working well" — the problem isn't tuning, it's that **there's no value of T that's correct under all load conditions**.

## 3. What a clean fix looks like

Replace "wait T milliseconds" with "wait until Claude has visibly absorbed the paste." This is event-driven: we hold the Enter until we see evidence that the paste pipeline completed.

cc-shell already has the machinery:
- `latestScreenRef.current[sessionId]` — a synchronous, always-current plain-text snapshot of Claude's TUI (`workspaceStore.ts:1951`). Updated whenever `window.api.onSessionScreen` fires, which is driven by the headless package's `emitScreen` (~60Hz with dedup on identical frames).
- `onSessionScreen` — an event stream we can subscribe to for screen transitions.
- The headless package owns the PTY and the screen snapshot; it's the right layer for this fix (see §6).

### The primary signal

When a paste hits the 800-char or >maxLines threshold (the common multi-line case we're trying to fix), Claude's composer renders a `[Pasted text #N +X lines]` placeholder on the input line. That string is straightforward to match in the screen snapshot.

Procedure:

1. Capture pre-paste screen → count existing `[Pasted text #` occurrences on the visible input area. Call it `n0`.
2. Send `\x1b[200~<text>\x1b[201~` (no Enter).
3. Subscribe to screen updates. On each update, count occurrences of `[Pasted text #`. When the count becomes ≥ `n0 + 1`, the placeholder has been inserted — the debounce has fired and React has committed.
4. Send `\r`.
5. Release the subscription.

Because step 3 is literal "wait for the state we care about", load-independent. 10ms or 10 seconds — we do the same thing.

### Signal for short pastes (<800 chars, ≤ maxLines)

Short multi-line pastes don't get placeholdered — Claude inlines them via `insertTextAtCursor(text)` (`PromptInput.tsx:1238`). No placeholder to match on.

Two options:

- **(A) Screen-diff wait**: snapshot input-area text before paste, wait for it to change, then send Enter.
- **(B) Don't care**: for small pastes, the existing race doesn't matter in practice (100ms is plenty for 50 chars). Keep the existing "paste + immediate `\r`" path for inputs below the multi-line threshold, and only engage the event-driven path when we know the placeholder will appear.

Recommendation: **(B)** — ship the heavyweight path only where we need it. Rules for engaging event-driven submit:
- `text.length > PASTE_THRESHOLD` (800), OR
- `text.includes('\n')` with more than 2 newlines (matches `maxLines = min(rows - 10, 2)` heuristic for typical window sizes).

Everything else takes the fast path: `send(text + '\r')` in one write.

### Fallback / safety net

Three failure modes to cover:

- **Placeholder never appears** (tokenizer ate PASTE_END; Claude crashed; Ink froze). We wait forever.
  → Cap with a timeout — say 2500ms. If no placeholder by then, log the anomaly and send `\r` anyway. Worst case: same behavior as today (the Enter may land wrong), but with a diagnostic we can grep for instead of silent sadness.

- **User kills the pane or switches sessions mid-wait**. The promise is still pending when we tear down.
  → Hook the wait to an abort signal tied to the session lifecycle. On abort, resolve-and-noop without sending `\r`.

- **Another paste from a sibling pane lands concurrently**. Different session, different screen, different ref — can't happen if we scope on `sessionId`.

### What about `pastedContents` count?

We could parse the incrementing placeholder ID (`#N`) and be more surgical: wait for a specific N = `max(existing N values) + 1`. This avoids miscounting when the composer already had placeholders. I'd do this. The regex is `/\[Pasted text #(\d+)/g` — walk matches, take max, treat 0 if none.

## 4. Solution space — what we considered and rejected

**(i) Tune the timer bigger.** Same bug with more delay. Rejected.

**(ii) Send text as individual keystrokes (type-it-out, not paste).**
Bypasses the bracketed-paste pipeline entirely — each char becomes a normal typed character. Rejected because:
- Claude's `PASTE_THRESHOLD = 800` fallback path still triggers on any single write > 800 chars. We'd have to chunk and delay ourselves — same timer hack, different layer.
- Can't represent newlines: `\r` / `\n` as raw keystrokes IS submit. There's no portable "Shift+Enter" byte sequence we can count on — Kitty keyboard protocol is negotiated, not guaranteed.
- Ink re-renders per character → visible flicker and poor perf for 5k-char pastes.

**(iii) Write the prompt to a temp file and use `@file` reference.**
Semantically different (the model sees an attachment, not an inline prompt). Rejected for general use.

**(iv) Fork Claude to expose a programmatic submit API.**
Too invasive — we don't own Claude's source. The headless package's `sendPrompt` is the closest we can get, and it has the same bug we're trying to fix. We fix it there.

**(v) Watch Claude's JSONL for the user entry.**
JSONL only gets the user entry at submit time, not at paste time. Doesn't help.

**(vi) Event-driven screen observation (this plan).** Chosen.

## 5. End-to-end pipeline after the fix

```
User hits Enter in cc-shell composer (TileLeaf onKeyDown)
  └→ workspace.submit(sessionId, text, images?)
     └→ providerAdapter.sendPrompt(sessionId, text, ...)
        ├── short / single-line text
        │   └→ pty.write(text + '\r')                  [unchanged]
        │
        └── long or multi-line text (> 800 chars OR > 2 newlines)
            ├→ preScreen = screenRef[sessionId]
            ├→ preCount  = maxPlaceholderId(preScreen)
            ├→ pty.write(`\x1b[200~${text}\x1b[201~`)  [NO carriage return]
            ├→ await waitForPlaceholder({
            │       sessionId,
            │       minId: preCount + 1,
            │       timeoutMs: 2500,
            │       abortSignal: session.abortSignal,
            │   })
            ├→ pty.write('\r')
            └→ clear composer draft
```

`waitForPlaceholder` is a small utility that:

- Reads `latestScreenRef.current[sessionId]` synchronously. If the placeholder is already visible (fast path — Ink committed before our await resolved), resolves immediately.
- Otherwise, subscribes to `onSessionScreen` for this sessionId and resolves the first time the max placeholder id ≥ `minId`.
- Races a `timeoutMs` timeout — on timeout, resolves with `{ ok: false, reason: 'timeout' }`.
- Races an abort — on abort, resolves with `{ ok: false, reason: 'aborted' }`.
- Always unsubscribes.

Caller decides what to do with `{ ok: false }` — for our case, log and fall back to sending `\r` anyway (current behavior is the floor, not the ceiling).

## 6. Where the fix lives

**Recommendation: move the authoritative paste logic into `claude-code-headless`, not cc-shell.**

Reasoning:

- The headless package already owns the PTY write path (`ClaudeCodeHeadless.write`, `.sendPrompt`) and the screen snapshot source (`HeadlessTerminal.snapshotPlain`). Both sides of the observation are already co-located there.
- The same bug exists in `ClaudeCodeHeadless.sendPrompt` today (line 1100: `\x1b[200~${text}\x1b[201~\r`). Anyone who uses the headless package programmatically hits it. Fixing it once, in that package, protects every consumer — including future ones beyond cc-shell.
- cc-shell becomes a thin caller: `headless.sendPrompt(text)` and trust it.

Concretely:

1. `ClaudeCodeHeadless.sendPrompt(text)` becomes **async** (breaking API change; limited blast radius — grep shows 2 call sites).
2. Adds internal helper `waitForPastePlaceholder(minId, timeoutMs)` that observes the terminal's own screen snapshot stream — no cross-package coupling needed.
3. Exports a `PasteAbsorbedEvent` or similar on the event channel so cc-shell can still surface timeout warnings in the UI if it wants to.
4. cc-shell drops `CLAUDE_PASTE_SUBMIT_DELAY_MS` and the hand-rolled `sendBracketedPasteThenSubmit` wrapper in `TileLeaf.tsx` — they become obsolete.

The codex path (`sendBracketedPasteThenSubmit(send, input)` at `TileLeaf.tsx:704`) is a separate code path with a separate provider. Codex's paste semantics are different (it doesn't have the placeholder-collapse mechanism) — its own plan if we want to clean that up too, but not strictly required for this fix.

## 7. Risks and open questions

### R1. Placeholder format could change upstream
We're matching on the literal string `[Pasted text #`. If Claude renames the placeholder text, our detector breaks — and silently falls back to the timeout path, which is ~2.5s per paste.

**Mitigation**: detector lives in one function, `maxPlaceholderId`, fed from a `PASTE_PLACEHOLDER_REGEX` constant in `claude-code-headless`. Keep a regression test fed from a recorded PTY fixture where a long paste is issued and the placeholder is observed. If the fixture breaks on a CC version bump, the test catches it.

### R2. Concurrent pastes within the same pane
User pastes A, before A's placeholder resolves they paste B. Session state gets two overlapping waits.

**Mitigation**: either serialize submits in `ClaudeCodeHeadless.sendPrompt` (one inflight at a time per session, await-chain the next), or cancel the prior wait when a new `sendPrompt` starts and let the last one win. Serializing is simpler and matches user intent — you can't submit two prompts simultaneously anyway.

### R3. Screen snapshot could lag behind the actual composer state
The headless screen snapshot is driven by Ink's draw frames. Between "Ink updates composer state" and "Ink paints the next frame", there's up to 1 frame of latency (~16ms at 60fps). We might miss the placeholder for one sample tick and wait one extra tick.

**Mitigation**: acceptable. 16ms tick isn't the "goofy timing" problem we're solving — that was 125ms wall clock hoping to catch a 100ms debounce. Polling a screen that's redrawing continuously is a much tighter loop.

### R4. What if the paste fails validation on Claude's side?
e.g. Claude decides the content is a malicious-looking path and refuses. The placeholder never appears.

**Mitigation**: we hit the 2.5s timeout, log, fall back to sending `\r`. The `\r` lands as a plain Enter at that point — likely a no-op, no harm done. User sees their composer empty and can retry. Same as any other protocol-failure fallback.

### R5. Window/viewport scrolled such that the composer line is off-screen
If the user scrolled the screen snapshot region, the input line might not be in the snapshot string we're searching.

**Mitigation**: `latestScreenRef` uses `recent` (a wider window — `workspaceStore.ts:1946-1950`). Composer/input lines live at the bottom of the TUI; `recent` always includes them. Not a risk in practice for the input line specifically.

### R6. Terminal doesn't support bracketed paste at all
If Claude's environment negotiates bracketed paste off, `\x1b[200~` and `\x1b[201~` would be interpreted as garbage. This isn't a new risk — existing code has this assumption — but worth noting.

**Mitigation**: out of scope for this plan. cc-shell's Claude sessions run under a PTY we control; we always have bracketed paste on. If we ever support external terminals, revisit.

### R7. Short-paste fast path could still race in edge cases
If the user pastes a 799-char single-line block, we skip the event-driven path. Single-line under 800 chars hitting the debounce? It would, but debounce ends in 100ms and our write+write is microseconds apart → Enter lands while `pastePendingRef` is still set → Enter absorbed.

**Mitigation**: either (a) lower the short-path threshold to engage the event-driven path more eagerly, or (b) for short inputs, still write `text + '\r'` in a SINGLE PTY write with the `\r` outside the bracketed sequence — which is exactly what Claude Code's own bracketed-paste emission does. This is the current "Codex path" at `TileLeaf.tsx:704` `sendBracketedPasteThenSubmit(send, input)` — it already works for Codex because Codex doesn't have the debounce. For Claude we need either (a) or investigate whether single-write paste-then-enter actually triggers the bug for ≤ 800 chars.

I'd start with **(a)**, engaging the event-driven path any time text > 100 chars OR contains a newline. The overhead is one extra screen read, negligible.

## 8. Phased implementation

This is a phased plan, not a single PR, because the fix touches two packages and we want to validate the signal before removing the timer entirely.

### Phase 1 — Build the detector (non-invasive)

Add `waitForPastePlaceholder(minId, timeoutMs)` to `claude-code-headless` as a new internal method. Wire it up behind a **feature flag** (env var `CC_HEADLESS_EVENT_DRIVEN_PASTE=1`). Keep the old `sendPrompt` path default-on.

Add a regression harness: a test that replays a recorded long-paste PTY transcript and asserts the detector fires at the expected moment. Fixture lives in `claude-code-headless/src/testing/fixtures/`.

**Exit criterion**: detector resolves correctly on fixture replay. No cc-shell changes yet.

### Phase 2 — Plumb the detector through `sendPrompt`

Make `sendPrompt` async. Behind the feature flag, run the event-driven path for long pastes. Keep the timer path as the non-flagged default. Emit a new event `paste_absorbed` / `paste_timeout` on the headless event stream so cc-shell can observe what happened.

Run cc-shell against a feature-flagged dev build, paste representative large inputs, verify submits land correctly. Collect `paste_timeout` occurrences in the logs to estimate the failure-mode tail.

**Exit criterion**: flagged path works for representative test cases; timeout rate is low enough to commit.

### Phase 3 — Flip the default, delete the timer

Feature flag becomes on-by-default. Remove `CLAUDE_PASTE_SUBMIT_DELAY_MS` and the `sendBracketedPasteThenSubmit` wrapper in `TileLeaf.tsx`. Remove the sync `sendPrompt` code path in `ClaudeCodeHeadless`.

Leave the feature flag in place (defaulted to the new behavior) for one release in case we need a quick rollback.

**Exit criterion**: no references to `CLAUDE_PASTE_SUBMIT_DELAY_MS` in cc-shell or headless. No timer-based waits in the paste pipeline.

### Phase 4 — Ship the same fix to Codex if needed

Codex path is at `TileLeaf.tsx:703-704`. Codex's CLI doesn't have the same debounce mechanism — does the timer-less single-write path actually hit any race? If yes, port the event-driven pattern to the Codex adapter. If no, leave alone.

## 9. What this plan deliberately does NOT do

- Doesn't touch the cc-shell composer side of paste (our React textarea). That side works.
- Doesn't add any new IPC surface. Everything runs inside the headless package or inside cc-shell, talking through the existing screen-snapshot stream.
- Doesn't try to "fix Claude's debounce." The 100ms debounce is Claude's correct behavior; we adapt to it instead of racing it.
- Doesn't introduce new user-visible UI. The whole thing is invisible when it works.

## 10. Decision needed from you

Before I write the implementation plan proper, I need sign-off on:

1. **Is the event-driven direction what you want?** (Alternative is keep tuning the timer — not recommended but you're the one living with it.)
2. **Headless package or cc-shell for the fix?** I recommend headless. If you'd rather keep the headless package dumb and put the smarts in cc-shell, that's viable but duplicates the logic.
3. **Threshold for engaging the event-driven path**: text > 100 chars OR contains newline (my recommendation), or text > 800 chars (match Claude's own threshold), or always (simplest, slightly more overhead per submit).
4. **Feature-flag rollout vs direct cutover**: phased (my recommendation) gives us the safety net. Direct cutover ships sooner.

Once you pick, I'll write the proper implementation plan with tasks, acceptance criteria, and file-level edits.
