# Codex: see a native draft before writing into it (#800, #1313)

## Evidence
codex-headless `testing/fixtures/composer-0157/idle-draft-ctrlc.json` is a raw PTY recording of codex-cli 0.157.0 (100×30; 112 output chunks, 65 synchronized-output opens and 65 closes).
- **Empty composer:** `› Ask Codex to do anything`, with the placeholder painted dim, then a blank row, the status row and a hint row (`← for agents · ? for shortcuts`).
- **Typed draft:** `› please review the draft`, in plain cells, with the hint gone. Codex paints it over 27 chunks within ~24 ms of the keystrokes. One redraw opens a synchronized update in one chunk and closes it in the next.

Before this PR:
- **#1313:** `isCodexNativeComposerEmpty` (text-only) cannot call the empty 0.157 composer empty: the placeholder is text, and the hint row sits below the status row. So every browser-pocket restart (`requireEmptyNativeComposer`) is refused.
- **#800:** nothing reads a native draft. `awaitReadyForPrompt` is ready whenever `›` and ` · ` are on screen, so a normal delivery pastes after the human's draft and submits both. Readiness latches after startup, so `nativeDraft` stays `unknown`.

## Change
**Package.** `packages/codex-headless` moves from `ae0e935` to the merge of codex-headless#55. That includes:
- #53: proxy chunks.
- #54: `CodexHeadless.getComposerState()` returns `empty`, `drafted` or `unknown`, from the live buffer's cell attributes and Codex's own empty hint, never from the cwd.
- #55: `CodexHeadless.getSettledScreen()` returns the plain viewport only for a settled frame, and `null` otherwise. Settled means no chunk is queued in the parser, no synchronized update is open, and Codex has painted since the last resize. The cell reading uses the same rule.

**The rule everywhere.** `drafted` means occupied. A proof of empty means ready. Anything else is neither (steering q40): it never consents, and it never latches occupied.

A proof of empty is either the package's `empty`, or the bare-`›` text proof read from the **settled** screen. The text proof is the only one 0.149.1 and narrow 0.157 panes can give, because they have no hint row. `getScreen()` is never used as a proof: it can show the paint from before the human's keystrokes.

- **Write gate (`awaitReadyForPrompt`):**
  - `drafted` returns `occupied` (`human-draft`). Delivery refuses with `retry-after-resolve` and writes nothing.
  - Text that nothing proves empty is refused at once, as a human's to resolve.
  - A text-only proof must hold on two consecutive settled polls 50 ms apart (#1319 review A). That covers the keystroke Codex has read but not yet painted, which no terminal can see.
  - A null settled screen resets the count.
- **Restart (`requireEmptyNativeComposer`):** the final check needs the same proof of empty, and it refuses on its own even after readiness said ready.
- **Readiness publication (`publishNativeComposer`, on each screen event after the startup latch):**

  | Frame | Published |
  |---|---|
  | `drafted` | `composer-occupied` |
  | proof of empty | `ready` |
  | anything else | `provider-not-ready`, without latching occupied |

  `nativeDraft` then reports `occupied`, and the pane shows "draft in agent composer — clear it to send", as it does for Claude.
- **Agent Code's own composer (`useComposerKeybinds`), while `composer-occupied`, for every provider:**
  - Enter and Send refuse, keep the draft, and toast how to clear the agent's draft (review C).
  - Ctrl+C reaches the agent, because that is how 0.157 clears a draft, and it keeps the user's Agent Code draft (review round 2 B).
- **Tool text:** the orchestration hold message and `nativeDraft` now mention a native draft.

## Tests
All red on main where they cover new behaviour. Integration tests drive the recorded 0.157 bytes through a real `CodexHeadless`.

`codexSession.nativeComposer.test.ts`:
- A restart into the recorded idle composer is delivered (#1313).
- A normal delivery into the recorded draft is refused with no write (#800).
- The draft publishes `composer-occupied`, and `ready` returns after Ctrl+C.
- A 13-row draft the reading cannot classify is never written into, and publishes `provider-not-ready` without latching.
- One stale bare-marker read does not consent.
- A bare marker with no settled frame never consents, for either the gate or the restart.
- A hintless pane returns to `ready` from a settled bare marker, and not while unsettled.
- The restart's final check refuses a draft after readiness said ready.

`codexSession.launchOrdering.test.ts`: publication through the real screen listener.

`useComposerKeybinds.tab.renderer.test.tsx`:
- Occupied Enter refuses for a text draft, for an image-only draft, and for a non-Codex provider.
- Ctrl+C passes through and keeps our draft.

The package tests are listed in codex-headless#54 and #55.

## Residuals
- **#1327:** a native draft the pane cannot classify publishes `provider-not-ready`, and Enter from Agent Code's composer still writes into it. Refusing every `provider-not-ready` would also block queueing a prompt during a turn. The fix is a separate "unreadable draft" readiness reason. Orchestration delivery already refuses this case.
- Readiness can blink `ready` → `provider-not-ready` while Codex streams on a hintless pane, because a flush can land mid-parse. This is display-only: keystrokes are not gated, and identical states are deduped.
- Under the known synchronized-output callback stall, the settled read stays null. Delivery then times out and refuses. That is the fail-closed direction.
