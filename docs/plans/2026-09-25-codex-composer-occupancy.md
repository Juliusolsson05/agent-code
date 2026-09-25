# Codex: see a native draft before writing into it (#800, #1313)

## Evidence
codex-headless `testing/fixtures/composer-0157/idle-draft-ctrlc.json` is a raw PTY recording of codex-cli 0.157.0.
- **Empty composer:** `› Ask Codex to do anything`, with the placeholder painted dim, then a blank row, the status row and a hint row (`← for agents · ? for shortcuts`).
- **Typed draft:** `› please review the draft`, in plain cells, with the hint gone.

Today:
- **#1313:** `isCodexNativeComposerEmpty` (text-only) cannot call the empty 0.157 composer empty: the placeholder is text, and the hint row sits below the status row. So every browser-pocket restart (`requireEmptyNativeComposer`) is refused.
- **#800:** nothing reads a native draft. `awaitReadyForPrompt` is ready whenever `›` and ` · ` are on screen, so a normal delivery pastes after the human's draft and submits both. Readiness latches after startup, so `nativeDraft` stays `unknown`.

## Change
This bumps codex-headless to `1ac3c50`, which includes #53 (proxy chunks) and #54 (`CodexHeadless.getComposerState()`: `empty`, `drafted` or `unknown`, from the live buffer's cell attributes and Codex's own empty hint).
- **Delivery:** `awaitReadyForPrompt` answers `occupied` (`human-draft`) when the composer reads `drafted`. The delivery then refuses with `retry-after-resolve` and writes nothing. `unknown` keeps today's behaviour, so a frame we cannot read never blocks a prompt.
- **Empty-composer requirement:** consent when the package says `empty`, or when the old text check proves a bare `›`. Anything else still refuses.
- **Readiness:** once the composer latch is set, each screen frame that reads `drafted` publishes `composer-occupied`, and one that reads `empty` publishes `ready`. `unknown` publishes nothing, so a turn in progress does not flap. This makes `nativeDraft` report `occupied` and the pane show "draft in agent composer — clear it to send", as it does for Claude.

## Tests (red on main, driven by the recorded 0.157 bytes through a real CodexHeadless)
- A restart request into the recorded idle composer is delivered (#1313).
- A normal delivery into the recorded draft is refused as occupied, with no write (#800).
- The session publishes `composer-occupied` on the draft frame, and `ready` again after Ctrl+C.
