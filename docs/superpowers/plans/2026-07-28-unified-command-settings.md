# One Command List in Settings

> **Status: IMPLEMENTED**, then revised after a two-reviewer pass (one Codex,
> one Claude). Both cleared the core — picker visibility stays presentation-only,
> no command lost or gained a row, the prune rule is correct for every tier.
> Between them they found one factual error in this plan (see the correction in
> §2), a missing accessible name on all 98 checkboxes, a lost Settings-search
> vocabulary, and a second copy of the group-gate rule that did not generalize.
> All fixed.

**Goal:** Settings has two lists of the same commands. Merge them into one — the
keybinding editor — with a palette-visibility checkbox on the right of each row.

**Why the keybinding editor wins:** it already has search across title, id,
description, keywords and chords; it already groups by category with an
exhaustive `CATEGORY_RANK`; and it is built from the **full** command catalog
rather than the picker-filtered subset. The visibility list has none of that —
it is a flat, unsearchable column of buttons.

**The load-bearing consequence, and the reason this merge is worth doing at
all:** because the keybinding list shows *every* command including the hidden
ones, the merged list is itself the "reveal all commands" surface. A user who
hid something finds it by searching Settings and re-ticking the box. That is why
this plan adds **no** reveal-all toggle and **no** bulk enable/disable — the
merge removes the need for both. `showHiddenCommands` stays exactly as it is: a
programmatic escape hatch (`SHOW_HIDDEN_COMMANDS = false` in
`CommandPalette.tsx`), not a user control.

---

## 1. The naming decision, settled up front

The checkbox column is labelled **Palette**, never "Enabled".

This is not cosmetic. `pickerVisibility.ts` carries an explicit READ-THIS block:
picker visibility is a *presentation* question and wiring it into any execution
path is a regression. The audit that produced that comment found a real
instance — the native File menu resolved ids against the picker-FILTERED
registry, so `commandVisibilityOverrides['new-tab'] = false`, a purely cosmetic
"tidy my palette" preference, silently killed **File → New Tab**. The user lost
a capability with no error and no way to connect cause to effect.

A column headed "Enabled" invites exactly that misreading from the next person
who touches this code. A command unticked here stays fully executable by
keybinding, by native menu, and by programmatic dispatch. The row proves it:
the same line still shows and edits that command's chord.

---

## 2. Three row states, not two

The merged list draws from `builtInCommandCatalog`; the old visibility list drew
from `listPickerCommandMeta()`. Those populations differ, and the group gate
adds a third case. Every row must render one of:

| State | When | Renders |
| --- | --- | --- |
| **Editable** | ordinary command | live checkbox |
| **Not applicable** | id in `PALETTE_SELF_EXCLUDED_COMMAND_IDS` | `—` + title explaining the palette never lists it |
| **Group-suppressed** | `commandGroup: 'navigation'` while `navigationCommandsEnabled` is false | disabled checkbox, unticked, title naming the parent switch |

**Correction (post-review):** an earlier draft of this plan claimed the third
state fixed a live defect — that Settings rendered all six navigation commands
as ON while the palette omitted them. **That was wrong**, and the review caught
it. At base `1e4f2d8f`, `resolveCommandVisible` already delegated to
`isVisibleInPicker` *including* `commandGroup`, so the old list computed the
checked state correctly. That bug existed once and was fixed in an earlier PR;
the past-tense comment on `PickerCommandMeta.commandGroup` describing it is what
misled the draft.

What the third state actually adds is smaller and worth stating honestly: those
rows previously rendered as an ordinary **enabled, unticked** checkbox with no
explanation. Clicking one wrote an override that changed nothing visible,
because `isVisibleInPicker` checks the group gate *before* per-command overrides
(deliberately: a child switch that appears able to contradict its disabled
parent is the "disabled parent, enabled child" trap). Now the row is disabled
and names the parent switch. Better affordance, not a correctness fix.

---

## 3. Where the logic comes from

Nothing new is written. Both halves already exist and are already tested:

- **Read** — `isVisibleInPicker(command, policy)` with
  `showHiddenCommands: false`. Settings shows the persisted preference, never
  the transient reveal-all state.
- **Write** — the prune-on-default rule currently inline in
  `settingsRegistry.ts`: setting a command back to its declared tier *deletes*
  the override rather than storing a redundant one, so the map only ever holds
  deliberate deviations and a future change to a command's declared default is
  not silently overridden by a stale entry.

Both move into `CommandKeybindingsRow.tsx` unchanged in behaviour.

---

## 4. Tasks

- [x] **Task 1 — Add the visibility column.** In `CommandKeybindingsRow.tsx`:
      read `commandVisibilityOverrides` + `navigationCommandsEnabled` from the
      store, compute per-row state per §2, render the checkbox at the right edge
      of each command row, and write through the prune-on-default rule.
      Extract that rule as an exported helper so it has exactly one home.
- [x] **Task 2 — Include visibility in the reset.** The row already has a reset
      for keybindings. Give the reset control both actions, clearly separated —
      one must not silently perform the other.
- [x] **Task 3 — Delete the old row.** Remove the `command-picker-visibility`
      registry entry, the `command-visibility` member of the `SettingDefinition`
      union, its `SettingsList.tsx` block, and `resolveCommandVisible` +
      `listPickerCommandMeta` if nothing else consumes them. Check before
      deleting: `listPickerCommandMeta` may have other callers.
- [x] **Task 4 — Keep search honest.** The search haystack must cover the new
      concern, otherwise a user typing "hidden" finds nothing. Include the
      command's declared tier in the searchable text.
- [x] **Task 5 — Verify.** `tsc` on both projects (raw — electron-vite and
      vitest do not type-check), `npm run check:keybindings`, full suite.

---

## 5. Constraints

- **Comment policy** (`CLAUDE.md`): thick WHY comments. The §1 naming decision
  and the §2 group-suppressed state both need the reasoning in the code, not
  only here — a future reader who "simplifies" the three states back to two
  reintroduces an enabled checkbox whose value the group gate silently
  outranks.
- **Copy style** (`docs/command-style.md`): stable noun-phrase titles, no
  Toggle/Enable/Show verbs.
- **Do not touch** `pickerVisibility.ts`'s resolution order, the
  `PALETTE_SELF_EXCLUDED_COMMAND_IDS` set, or `SHOW_HIDDEN_COMMANDS`.
- Tests go beside their source (`testing/README.md`); filename picks the Vitest
  project.

---

## 6. Self-review

**Was least certain, and the review confirmed it mattered:** whether the
Settings copy still read correctly once two rows became one. It did not — the
surviving row kept only the keybinding vocabulary, so a user searching Settings
for "hide" or "visibility" got zero results even though the control was right
there. Both the row's keywords/description and the `commands` category
description now cover both concerns.

**Deliberately out of scope:** a reveal-all control (the merged list is one),
bulk enable/disable (an empty palette with no obvious way back is a worse state
than the problem it solves), and per-category bulk actions.

**Known limitation kept:** function-typed titles still fall back to the command
id as their label, because resolving them needs a live `CommandContext` that
Settings deliberately does not have.
