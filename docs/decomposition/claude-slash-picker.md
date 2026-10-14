# Claude slash picker: anchor detection to the composer

Status: **in review, revised after review round 1**. H3 was disproven by both
reviewers and by recordings A and C, so Stage 2 was redone with a
description-column rule (see "Review round 1"). claude-code-headless#72 and
agent-code#1478 are open, not merged.
Approval mode: **pre-authorized** (owner, 2026-10-14: "use the staged
decomposition principles … tell me when we have the PR open"). Stop-and-ask
triggers: a recording contradicts H1, or the fix needs a rule beyond "the
block on top of the composer".
Issue: #1477 (slash-picker part of #1293).

## A: what exists and is trusted

`detectSlashPicker` (claude-code-headless `src/parsers/SlashPickerParser.ts`)
reads the live xterm grid. It reports every viewport row whose first
non-space cell is a `/` painted in a non-default colour. The most common
colour among those rows counts as "unselected", and any other colour as
"selected". `ClaudeCodeHeadless` publishes the result as `slashPicker` in the
condition snapshot. Agent Code renders it as the composer's **Slash commands**
listbox (`SlashCommandPicker.tsx`).

Trusted: one real recording, `test/fixtures/slash-picker/colour-only-selection-2.1.283.json`
(#1253). It proves selection changes on 2.1.283.

It does **not** establish where the picker sits on screen, what else on
screen can look like a picker row, or how 2.1.296 draws the selected row.
The header comment's layout claim comes from the vendored source, where
`PromptInputFooterSuggestions` is drawn inside the footer below the input.
The installed binary disproves it (H4).

## D: the observable end state

1. A transcript row starting with a coloured `/` never becomes a picker item.
   An example is a wrapped `$ …` Bash line such as `     /shots && sleep 30 …`.
2. With no picker open, `detectSlashPicker` returns hidden, even while such
   rows are on screen.
3. With the picker open, items are exactly Claude's rows, in order.
4. The selected item is the one Claude marks:
   - on 2.1.296, the `❯` row (`  ❯ /clear …`), which is no longer dropped;
   - on 2.1.283, the row whose colour differs (unchanged behaviour).
5. A description that Claude wraps onto continuation rows is reported whole.
6. Every 2.1.283 behaviour the existing #1253 tests pin still holds.

## Facts (Stage 0 results)

Methods: extracting from the bundle on disk, then probing the real binary
(Claude Code 2.1.296 under node-pty, no Agent Code). Raw recordings live in
the session scratchpad; the committed fixture is listed under
"Fixture plan" below.

- **Bundle `manual/2026-10-14T00-51-55-934-e14bb3c2` ("Weird slash glitch").**
  In `html-clean.html` the `Slash commands` listbox holds one option: the
  wrapped Bash row `/scratchpad/shots && cd $S && sed -i '' …`.
  `trace/screen`: 175 of 300 samples contain such a row.
- **All 71 local bundles:** 29 bundles and 1,050 of 10,480 samples contain a
  transcript row that starts with `/`. This is an upper bound: tail samples are
  plain text, so colour is unknown.
- **Wrapped Bash row colour:** fg `#999999` (RGB mode). That equals the
  unselected picker row colour (`#999999`) in the same build. The selected
  picker row is `#B1B9F9`.
- **Inline code colour** (found during Stage 2): a reply line and a prompt
  echo starting with `` `/compact` `` are painted `#B1B9F9`, the **selected**
  picker colour. The reply's last such row is followed by a blank row and the
  `✻ Baked for 1s` status row. This is #1293's inline-code case.
- **Picker position:** in 6 of 6 screens, the picker block ends on the row
  directly above the composer's top rule (`───…` / `❯ …` / `───…`):
  - 2.1.296 at 120 columns: idle, filtered (`/com`), and opened while a Bash
    command runs;
  - 2.1.296 at 60 columns;
  - 2.1.283 (committed recording): `open-filtered` and the arrow steps.
- **Selected row shape:**
  - 2.1.296: `  ❯ /clear   Start a …` and `  ❯ * /agent-code-conventions – …`.
    The first glyph is `❯`, so today's parser skips the row.
  - 2.1.283: `  /copy   Copy …`, marked only by colour.
- **Continuation rows:** indented to the description column (x=52 at 120
  columns, x=28 at 60, x=39 on 2.1.283). Their first glyph is never `/`.
- **The current parser on the new 2.1.296 recording:**
  - `submit` (Bash running, no picker): visible, with item
    `/shots && sleep 30 && echo $S (11s)`.
  - `open-filtered`: items `/shots …` and `/claude-api`. `/clear` is missing
    and nothing is selected.
  - `escape`: still visible, with the Bash row.

## Hypotheses

- **H1.** The picker is the contiguous block of rows directly above the
  composer's top rule. Would be killed by a real picker screen with any other
  row between the block and the rule. **Verdict: HOLDS** (6/6 screens across
  two versions, two widths, idle and running).
- **H2.** On 2.1.296 the selected row carries a literal `❯ ` before the
  command. Would be killed by a 2.1.296 picker whose selected row has no `❯`.
  **Verdict: HOLDS** (4/4 screens). On 2.1.283 it is absent. Colour remains
  the fallback.
- **H3.** A continuation row never starts with `/` and is indented further
  than the item row's command. Would be killed by a description that wraps
  onto a row starting with `/`. **Verdict: DISPROVEN**, moved to the
  graveyard. Recording A shows `/loop 5m /foo). Omit…` as a continuation row.
  The Codex reviewer reproduced `/resume)` at 156–160 columns. Replaced by H6.
- **H6.** Claude lays the picker out in two columns. Every padded item row
  starts its description at one shared column D, and every continuation row
  starts exactly at D, whatever its first glyph. Item rows put their `/` (or
  `❯`/`*` prefix) left of D. Would be killed by a real picker whose
  continuation rows start anywhere other than the padded rows' description
  column. **Verdict: HOLDS** in every padded picker recorded:
  - 2.1.296: D=52 at 120 columns, 48 at 111, 28 at 60;
  - 2.1.283: D=39 at 100 columns;
  - the reviewers' 108–160 column sweeps.

  `– `-joined rows (skills with a `*` marker) are not padded and never wrap:
  Claude truncates them with `…`.
- **H7.** The row directly above the composer rule, when no picker is open,
  can be a right-aligned hint such as `◐ medium · /effort`,
  `Ctrl+Y to paste deleted text` or `✘ Auto-update failed · Run /doctor`. It
  is indented but is not part of any picker. Would be killed by nothing: it is
  observed. **Verdict: HOLDS** in recording C and two bundles found by the
  Codex reviewer. This is why "indented and not `/`-led" (the H3 rule) was
  wrong: it let the walk climb through the hint into the transcript.
- **H4.** The picker renders below the composer, as the vendored source and
  the parser header say. **Verdict: DISPROVEN** for 2.1.283 and 2.1.296.
  Moved to the graveyard.
- **H5.** Colour separates picker rows from transcript rows. **Verdict:
  DISPROVEN**: the wrapped Bash row and the unselected picker rows are both
  `#999999`. Moved to the graveyard.

## Stages

### Stage 0: evidence (done)
- **Produces:** the facts above, plus a step-sliced 2.1.296 PTY recording.
- **Verified by:** replaying it in `@xterm/headless` and reading every row and
  first-cell colour per step.
- **Why separate:** the parser's own header was wrong about layout (H4). Any
  rule written before recording would have encoded that error. #1293's
  suggested direction, "anchor below the last divider / the composer box",
  makes the same mistake for this predicate.
- **Reality check:** recordings from the installed binary, plus the user's
  bundle.

### Stage 1: committed fixture plus fail-first tests
- **Produces:**
  - `test/fixtures/slash-picker/transcript-bash-wrap-2.1.296.json` and
    `reply-inline-code-2.1.296.json` (added in Stage 2, see below), each with
    a README section;
  - tests that drive it through the real `ClaudeCodeHeadless` /
    `HeadlessTerminal`, as the #1253 tests do.
- **Verified by:** the tests are red on today's parser for D1–D5 and the
  #1253 suite stays green.
- **Why separate:** without it, "fixed" would be judged by the parser's own
  author against imagined rows.
- **Reality check:** the recording, unchanged except for a same-length
  redaction of the account plan (`Claude Max` → `Claude XXX`). Replayed screens
  were diffed before and after; only that banner row differs.

### Stage 2: anchor detection to the composer
- **Produces:** the rewritten `detectSlashPicker`:
  1. Find the composer's top rule: a divider row directly followed by a
     `❯`/`>` row.
  2. Walk upward while rows are picker item rows (`/command`, optionally
     preceded by `❯ ` and `* `) or continuation rows.
  3. Hidden if no item rows touch the rule.
  4. Selected = the `❯` row; otherwise the colour rule.
- **Verified by:** the Stage 1 tests turn green, and the old parser turns both
  new tests red. Each guard was mutated on its own:
  - stop rule, anchor, `❯` selection, continuation join and colour fallback:
    all killed;
  - colour requirement on item rows: survived, so the guard was removed.
- **Deviation:** two guards from the first draft were removed. The Bash
  fixture alone could not tell them apart from the stop rule:
  - a continuation-indent check, which was redundant on every recording;
  - the colour requirement, which no recording needs and which would break
    under `NO_COLOR`.

  The inline-code recording was added because it is the one real frame where
  only the stop rule rejects a `/` row.
- **Why separate:** it is the only behavioural change. Everything else is
  evidence or wiring.
- **Reality check:** the Stage 1 fixtures.

### Stage 2b: description-column rule (after review round 1)
- **Produces:** the parser classifies rows by column:
  - D comes from the bottom-most padded item row in the contiguous non-blank
    run above the rule;
  - a continuation row is one whose first ink is exactly at D;
  - an item row matches the item shape with its `/` left of D;
  - anything else ends the picker.
- **Verified by:** recordings A and C are red before the change and green
  after. Mutants of each rule are killed by A or C.
- **Why separate:** H3 was the substrate of the continuation logic. Patching it
  with another conditional (for example "and not right-aligned") would be the
  second conditional for one bug family.
- **Reality check:** recordings A (`lo-wrap-arrows-2.1.296.json`) and C
  (`compact-hint-2.1.296.json`), plus the reviewers' 108–160 column sweeps.

### Stage 3: ship through Agent Code
- **Produces:** the claude-code-headless PR, then the agent-code submodule
  bump. No lockfile change: the package's `package.json` did not change.
- **Verified by:** `npx tsc -b`, the package suite, and the app's picker
  renderer tests.
- **Why separate:** two repositories. The gitlink must point at a pushed
  package commit.
- **Reality check:** none needed beyond Stages 1 and 2.

## What is isolated

All detection stays in `SlashPickerParser.ts`, which takes a terminal and
returns `SlashPickerState`. The output type is unchanged, so `ClaudeCodeHeadless`,
the `claude.slash-picker` condition and Agent Code need no change. The composer
locator stays private to the parser. `ScreenParser.parseClaudeComposerState`
works on plain strings, while this parser needs cells, so they share
`isDividerLine` only.

## Unknowns

1. What the `*` before `/agent-code-conventions` means (2.1.296, unfiltered
   picker). It looks like a marker on a user-installed skill. The parser
   strips it from the id either way. Answered by: a later recording, not
   needed for this fix.
2. ~~Can a description wrap so a continuation row starts with `/`?~~
   **Answered: yes** (recording A, review round 1). Now handled by H6.
3. ~~A transcript row directly above the composer rule with nothing between.~~
   **Answered: yes, through a hint row** (H7, recording C). Handled because
   a hint row is neither an item nor at D.
5. **Very short panes.** At 60×6 and 60×5, Claude draws the picker but omits
   the divider, so detection reports hidden. This came from the Codex reviewer
   and is not fixed: a 6-row Claude pane is not a supported layout, and
   anchoring without the divider would widen the false-positive surface this
   fix closes. Answered by: a user report of a real pane that small.
6. **D coincidence.** A right-aligned hint whose first character lands exactly
   on D, under a padded `/x   y` row, would be read as a continuation. That
   needs two coincidences at once and has not been seen. Answered by: corpus
   recordings over time.
4. The other three predicates in #1293 (permission prompt, compaction, Codex
   readiness). Out of scope here and still open in #1293.

## Fixture plan

- `transcript-bash-wrap-2.1.296.json`: a **recording** with steps
  `startup`, `prompt`, `submit`, `open-filtered`, `escape`. Sliced by send
  time and checked by content per step: each step's replayed screen shows
  the stated state.
- `reply-inline-code-2.1.296.json`: a **recording** with the same steps;
  `/`-led inline code in a reply and the prompt echo, then the same picker.
- `lo-wrap-arrows-2.1.296.json` (recording A, 111×40): `/lo` with a
  `/`-led continuation row, ↓ ↓ ↑ moving `❯`, then `/agent-code-co`
  (`* ` and ` – ` rows).
- `compact-hint-2.1.296.json` (recording C, 120×12): a real `/compact`, then
  a right-aligned hint directly on the rule under the `❯ /compact` echo.
- `colour-only-selection-2.1.283.json`: an existing **recording**, kept as
  the regression guard for D4/D6.

## Graveyard

- **H4: "the picker renders in the footer below the composer".** It came from
  reading vendored `PromptInputFooter.tsx`. Both installed versions draw it
  above the composer's top rule. Vendored source is older than the binary.
- **H3: "a continuation row is any indented row not led by `/`".** Killed
  twice. A description can wrap onto `/foo)` or `/resume)` (a phantom item).
  A right-aligned hint is indented too, which let the walk reach transcript
  `❯ /compact` (a phantom selected command).
- **H5: "a coloured leading `/` identifies picker rows".** The wrapped Bash
  row is `#999999`, identical to unselected picker rows, and inline code is
  `#B1B9F9`, identical to the selected one.

## Review round 1

One round, two reviewers: Codex (parser logic, real layouts) and Claude Code
(tests, evidence, integration). The disposition table is in claude-code-headless#72.
- **Both reviewers** reproduced H3's failure on the real binary.
- **Codex** found H7 in two of the user's bundles and the short-pane miss
  (Unknown 5).
- **Claude** found the evidence and comment inaccuracies:
  - the "every guard killed" claim was wrong: 8 of 16 mutants survived;
  - the separator while the picker is open is always a blank row, because
    the spinner is hidden;
  - the Stage 3 lockfile wording was stale.
