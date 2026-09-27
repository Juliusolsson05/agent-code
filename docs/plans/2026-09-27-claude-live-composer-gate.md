# Claude delivery reads the composer live before writing (#1294)

## Evidence (origin/main 95aff39b)
- **Delivery trusts a cached reading.** `deliverClaudePrompt` gates on `awaitReadyForPrompt` / `isPromptAcceptanceReady`, and both derive from `ClaudeSession.derivePromptGateState`. That reads `headless.getComposerState()`, a per-frame cache the package recomputes only on its throttled `screen` event. That event can stall behind `pendingWrites` (claude-code-headless `HeadlessTerminal.ts`, "KNOWN ISSUE"). Once it stalls, a stale `empty` survives while a human types, and delivery writes the agent's prompt into the draft and presses Enter.
- **The cached classifier misreads some real drafts.** It counts only non-dim, non-inverse ("plain") cells as typed. It reads `empty` for:
  - a one-character draft (the character sits under the inverse cursor);
  - an `[Image #1]`-only draft (the whole chip is inverted, with the cursor at its start).
  
  So the cached gate says ready over a human draft even without a stall.
- **The fix already exists for the rollback path.** #1309 gave that path a live read: `ClaudeSession.readComposer()` returns the screen and the composer cell attributes from the LIVE buffer at the same instant. Its classifier `classifyRollbackComposer` fails closed:
  - text-only is the base;
  - it is overruled to `empty` only for a dim-only placeholder;
  - it is overruled to `drafted` when an allowlisted hint row holds typed cells.
  
  Under it, both drafts above read `drafted`.

## Change
- **A live guard.** Immediately before the first prompt byte (text and image paths alike), `deliverClaudePrompt` reads the composer live and classifies it with the same classifier. A `drafted` result is a `before-write` / `occupied` failure: retry-safe, nothing written. An `unpainted` result is a `before-write` / `not-ready` failure. The cached gate still drives the UI's readiness events; it just no longer has the last word on writing.
- **Rename.** The classifier becomes `classifyClaudeComposerLive`, as it now serves both the pre-write guard and the rollback. It is exported from `promptDelivery.ts` as before.

## Tests
Frames are painted through claude-code-headless's real `HeadlessTerminal` with genuine SGR sequences, as its own composer tests do, so the attribute counts come from xterm's parse. Each case uses a cached gate that says ready and a live buffer that disagrees:
1. a plain human draft typed after the last screen event (the stall);
2. a one-character draft under the inverse cursor;
3. an `[Image #1]`-only draft.

Each case must fail `before-write` / `occupied` with no bytes written, and each is red on main. A dim prompt-suggestion placeholder must still be delivered, so the guard does not re-create the false `drafted` that attributes were added to fix.

## Residual
Native voice interim text is painted dim, the same as a placeholder, so the live read also calls it `empty`. There is no recorded frame of it, and no attribute separates it from a suggestion. It is stated, not guessed at.
