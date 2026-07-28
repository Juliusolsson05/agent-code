# Composer Commands (Clear / Send) Implementation Plan

> **Status:** IMPLEMENTED in PR #619. Both open questions were resolved in
> favour of the recommendations below: **no Mouse Mode gate** (Q1) and
> **undoable clear** (Q2).
>
> **Where the implementation differs from this plan:**
>
> - **Undo is a third COMMAND, not an action inside the pane toast.**
>   `PaneToast` renders text only — it has no action slot — so an in-toast Undo
>   would have meant a new UI primitive plus storing a callback in runtime
>   state. `undo-close` is the existing precedent for a reversible destructive
>   action, and it is a command. So: `undo-clear-composer`.
> - **The stash lives in module state in `actions/draft.ts`, not on
>   `SessionRuntime`.** Nothing renders from it, so putting it on the runtime
>   would add a field every reducer, debug bundle and replay fixture carries for
>   a value the UI never reads.
> - **`undo-clear-composer` ships with no `when` guard**, mirroring
>   `undo-close`. A guard would have to read that module state, which the
>   command registry does not re-derive on, so it would go stale.
> - **Undo restores text only, not attached images.** Re-inserting images could
>   resurrect one the user deliberately removed in the same gesture.
> - Three commands were added, so `catalog.test.ts` moved 99 → 102 across its
>   ordered snapshot, its length assertion, and both arithmetic assertions.

**Goal:** Give the composer two palette-reachable actions — clear the draft, and send it — so a user driving Agent Code with a mouse can undo a mistyped prompt and submit without reaching for the keyboard.

**Why now:** the mouse-first work made *writing* a prompt mouse-drivable but not *un*-writing one. With a mouse you can dictate or type into the composer, but clearing it means select-all-and-delete, which is a keyboard gesture. The gap is small and the fix is small, but it sits directly on the lean-back loop.

---

## What already exists (verified, not assumed)

| Need | Where it already lives |
|---|---|
| The draft itself | `SessionRuntime.draftInput` (`session-runtime/state.ts:375`) and `draftImages` (`:376`) |
| Writing the draft | `workspace.setDraftInput(sessionId, text)` and `workspace.setDraftImages` — both already exposed on the workspace object (`workspace/hook/index.ts:917`) |
| Finding the command's target | `commandTargetSessionIdForState` (`workspace/hook/selectors/commandTargetSessionId.ts`), the same helper `copy-last-assistant` uses |
| Submitting | `ComposerEnterTargetHandle.submit()` and `.hasSubmittableDraft()` in `composerEnterRegistry.ts` — the registry the global-Enter router already drives |

**So Clear needs no new plumbing at all** — it is a workspace call from a command's `run`. **Send needs one new export** from `composerEnterRegistry`, mirroring the shape `dictationHotkeyRegistry` already uses (a module-level function that picks the active target and calls into it), because `submit` is owned by the registry rather than by workspace.

That shared seam is the argument for doing both together rather than one now and one later.

---

## Q1 — Should these be gated behind Mouse Mode?

**Your proposal:** hidden/disabled by default; enabling Mouse Mode enables them; the user can still enable them manually from the command-visibility list.

**My recommendation: no gate. Ship them as ordinary `default`-tier commands, always visible.** Three reasons, in order of weight:

**1. "Disabled by default" is not achievable through visibility, and that is deliberate.** `pickerVisibility.ts` states the invariant plainly — picker state is presentation only, never authorization — and `executeCommand.test.ts` carries four cases proving a `commandVisibilityOverrides[id] = false` does *not* block dispatch. So the most a visibility gate can do is *hide* them. A hidden command still runs from a keybinding, from the native menu, and from any other invocation source. If the intent is "these should not be usable yet," visibility is the wrong mechanism entirely.

**2. The gate costs real plumbing for a mechanism that does not exist.** Visibility is resolved inside `buildCommandRegistry`, so `mouseModeEnabled` would have to travel in `CommandContext.flags` — the "three edits" rule from the activation-semantics plan (flags type, context literal, memo dep array), where missing the third is a documented silent-staleness bug. And `pickerVisibility` is a *static* declared tier today; making it depend on a setting introduces dynamic visibility as a new concept the system has never had.

**3. The payoff is negative — it hides them from the people most likely to bind them.** Clear Composer is *more* useful to a keyboard user, not less: it is the natural target for a chord. Hiding it behind Mouse Mode means a keyboard user never discovers it exists. The shipped D4 rationale for gating the Send/Stop buttons was specifically that they are **visually noisy** — a permanent ~28px row in every agent pane that an Enter user gets nothing from. One row in a searchable 99-item list is not noise in that sense. The principle was "gate what costs you when unused," and a palette command costs nothing when unused.

**If you still want the coupling**, the honest version is not a visibility gate but a **one-time reveal**: when Mouse Mode is switched on, write `commandVisibilityOverrides[id] = true` for both commands. That matches "if you enable mouse mode, it will be enabled," keeps visibility static, and leaves the user in control afterwards. Its cost is that it silently writes to the user's settings, and turning Mouse Mode back off would not un-write it (nor should it — that would clobber a deliberate manual choice). I would still not do it, but it is the version that fits the existing system.

---

## Q2 — How destructive should Clear Composer be?

Clearing throws away typed text with no undo. In a palette that is one mis-click away from a long prompt you just wrote — and the palette is now reachable by a mouse chord, so mis-clicks get cheaper.

Options:

- **(a) Just clear it.** The composer is a scratchpad; provider history still has previously *sent* prompts. Simplest, and defensible.
- **(b) Clear, then offer Undo in the existing pane toast.** `PaneToast` is already mounted in `TileLeaf`, and `undo-close` is the repo's precedent for making a destructive action reversible rather than confirmed. Costs stashing the cleared text on the runtime.
- **(c) Guard with `when`** so the command only appears when the draft is non-empty. Cheap, and worth doing regardless — but it does not help the mis-click case, since a non-empty draft is exactly when the command is visible.

**My recommendation: (b) plus (c).** (c) alone leaves the sharp edge; a confirm dialog would be worse than either, since confirming every clear is the kind of friction that makes a mouse-first flow annoying.

---

## Command definitions (pending Q1/Q2)

Both are one-shot actions, so **imperative verb titles** per `docs/command-style.md` rule 4 — not noun phrases, which are reserved for toggles and modes.

| | Clear | Send |
|---|---|---|
| id | `clear-composer` | `send-composer` |
| title | `Clear Composer` | `Send Prompt` |
| surface | `session` | `session` |
| category | `session` | `session` |
| tier | `default` (pending Q1) | `default` (pending Q1) |
| `when` | target exists, kind ≠ terminal, draft non-empty | target exists, kind ≠ terminal, `hasSubmittableDraft()` |

`surface: 'session'` is correct per rule 12 — both act on the visible focused agent.

**Terminals are excluded** for the same reason `copy-last-assistant` excludes them: a terminal pane has no composer draft at all — its input goes straight to the PTY — so the command would imply a draft that does not exist.

---

## Governance constraints this must satisfy

These bite hard and are easy to miss:

- **`catalog.test.ts` pins an ordered id snapshot AND a literal count.** `BASELINE_COMMAND_IDS` and `toHaveLength(99)` both have to be updated to 101 **in the same commit**, with the additions placed at a deliberate position — registration order is the palette's empty-query browse order and is a declared user-visible invariant.
- **Do not use the `experimental` tier.** `catalog.test.ts` asserts `experimental === 1`; a second experimental command fails the suite.
- **`category` is enforced by test** (`taxonomy.test.ts`), even though the type makes it optional.
- **Never author a `shortcut` field** — `check:keybindings` hard-fails on it; the displayed shortcut is derived.
- If either ships with a default chord, `check:keybindings` must stay clean, including against `DEFAULT_DICTATION_HOTKEY`. **Recommendation: ship both unbound.** Most of the catalog is unbound and user-bindable, and a Clear that is one keystroke away is a footgun.
- Description follows the house markdown convention: `**What it does:** … **Use when:** … **Notes:** …`.

---

## Task sketch (to be expanded once Q1/Q2 are settled)

1. **`composerEnterRegistry`** gains a module-level `submitActiveComposer(): boolean` (and `activeComposerHasDraft(): boolean` for the `when` guard), mirroring `dictationHotkeyRegistry`'s exported begin/end functions. Returns whether it found a target, so the command can no-op cleanly.
2. **`clear-composer`** in `sessionCommands.ts`: resolve target, `setDraftInput(id, '')`, `setDraftImages(id, [])`, and — if Q2 lands on (b) — stash the previous draft and raise a pane toast with Undo.
3. **`send-composer`** in `sessionCommands.ts`: resolve target, call `submitActiveComposer()`.
4. **Catalog registration** + the `catalog.test.ts` snapshot/count update in the same commit.
5. Verify: `npx tsc -b`, full vitest, `npm run check:keybindings`, `npm run test:contract`.

---

## Open questions

- **Q1** — gate behind Mouse Mode, or ship always-visible? (I recommend always-visible; see above.)
- **Q2** — Clear: plain, or undoable via pane toast? (I recommend undoable + a non-empty `when` guard.)
