# Composer Placeholder Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Not started. Created 2026-07-19.

**Goal:** Stop Agent Code from misreading Claude's dimmed composer placeholder text as a human draft, which permanently blocks prompt delivery and pins the UI at "Starting agent".

**Architecture:** Claude renders every composer placeholder through one upstream
code path — `chalk.dim` (SGR 2), and *only* when the composer value is empty
(`vendor/claude-code-src/full/hooks/renderPlaceholder.ts:33-45`). The current
parser reads the screen as plain text, where that styling is erased, so
placeholder prose is indistinguishable from typed prose. We add a cell-attribute
channel: `HeadlessTerminal` extracts a tiny per-frame descriptor of the composer
row (how many content cells are dim / inverse / plain) and
`parseClaudeComposerState` prefers it over string matching when present. Any
content cell that is neither dim nor the inverted cursor is text the human owns.

**Tech Stack:** TypeScript, `@xterm/headless` (cell attribute reads via
`IBufferCell.isDim()` / `isInverse()`), Vitest 4, node-pty.

---

## Background: what is actually broken

Verified 2026-07-19 against live session `ef052e06-0538-44b1-a4bd-54b1e5eb324c`
and a live `claude` 2.1.215 PTY in a temp cwd.

**Symptom:** UI pinned at "Starting agent"; sending a prompt fails with
`Claude session <id> prompt input is occupied by a human draft`.

**Causal chain:**

1. `parseClaudeComposerState(screen)` reads the composer row as plain text
   (`packages/claude-code-headless/src/parsers/ScreenParser.ts:63`).
2. It classifies anything it does not recognise as `'drafted'` — deliberately
   failing closed against an allowlist with **one** entry,
   `EMPTY_COMPOSER_HINTS = new Set(['Press up to edit'])` (`ScreenParser.ts:47`).
3. `derivePromptGateState` maps `'drafted'` → `{ kind: 'occupied', reason:
   'human-draft' }` (`src/providers/claude/runtime/claudeSession.ts:758-759`).
4. `occupied` is a non-ready gate state, so `input-readiness` never publishes
   and `describeReadiness` renders the user-visible error
   (`src/providers/claude/runtime/promptDelivery.ts:315`).

**Why the allowlist can never be completed.** `usePromptInputPlaceholder`
returns a placeholder *only* when `input === ''`
(`vendor/claude-code-src/full/components/PromptInput/usePromptInputPlaceholder.ts:32-73`),
and it can be any of four things:

| Source | Example | Bounded? |
|---|---|---|
| Queue hint | `Press up to edit queued messages` | yes |
| Teammate hint | `Message @<name>…` | no — user data |
| Example command | generated from your git history | no |
| **Prompt suggestion** (`PromptInput.tsx:2014`) | `now count backwards from 30 to 1` | no — model-authored prose |

**Measured impact** (2,588 recorded screens replayed through the real parser):
1,114 screens (43%) classified `drafted`; one continuous window of **186.8
seconds**; **zero** `session:input-readiness` events in the entire recording.

**Regression origin:** the whole composer-state feature landed 2026-07-19 00:06
in `claude-code-headless` commit `46630ae` (PR #39). This is a day-old
regression, not longstanding behaviour.

**Live PTY validation of the proposed rule** (8 forced states, real `claude`):
shipped string parser wrong on 2/8; candidate attribute detector wrong on 0/8.
The two failures were both dim placeholders (`dim=26 plain=0`) over a genuinely
empty composer.

**Rejected alternative — matching against proxy-captured suggestions.** Measured
on the same recording: correct on timing (the proxy event *always* preceded the
composer paint, by 0ms–232s) but explained only 3 of 11 drafted windows. It
cannot see the 186.8s window at all, because queue hints, example commands and
teammate hints never touch the API. It also breaks on truncation — the composer
ellipsizes, so proxy `'…recording change'` vs composer `'…recording c…'` fails
an exact match. Keep the proxy signal out of this fix.

---

## Global Constraints

- **Two repositories.** Tasks 1–4 and 6 land in the `claude-code-headless`
  submodule (its own GitHub repo, its own PR). Tasks 5 and 7 land in
  `agent-code`. The gitlink bump (Task 7) must merge *after* the submodule PR,
  or `agent-code` still pins the broken parser.
- **Submodule is on `main`** at `6f2d57f` in this worktree. Branch from `main`,
  not from a detached HEAD.
- **No new test files in `agent-code`.** Per repository convention, extend
  existing test files. The submodule's live-tier file is a deliberate exception
  (Task 6) — its `.live` tier exists and is empty by design.
- **Thick WHY comments** are mandatory per `AGENTS.md`. Explain what constraint
  forced the shape, not what the code does.
- **`tsc -b` is the only type gate** — neither the build nor Vitest type-checks.
- **No redaction of developer evidence.** Composer *text* is already captured in
  screens; this plan adds only counts, never new text capture.
- **Vitest 4**, `NODE_ENV` must be unset for renderer tests.

---

## File Structure

**`claude-code-headless` (submodule):**

| File | Responsibility |
|---|---|
| `src/parsers/ScreenParser.ts` | Add `ComposerAttributes` type; extend `parseClaudeComposerState` with an optional second parameter that takes precedence over string matching. Stays pure — no xterm import. |
| `src/terminal/HeadlessTerminal.ts` | Add `snapshotComposerAttributes()`. The only place that touches xterm cells. Uses the existing `getTerminal()` precedent. |
| `src/ClaudeCodeHeadless.ts` | Line 549: pass the attribute descriptor into the parser. |
| `src/index.ts` | Export the new type. |
| `src/parsers/ScreenParser.composer.test.ts` | Extend — deterministic unit tests. |
| `test/live/composerDetection.live.test.ts` | **New.** Live PTY test in the empty `.live` tier. |

**`agent-code`:**

| File | Responsibility |
|---|---|
| `src/providers/claude/runtime/claudeSession.ts` | Bounded-staleness escape hatch so `occupied` can never be permanent. |
| `packages/claude-code-headless` (gitlink) | Bump to the merged submodule commit. |

**Design rationale — why the split.** `ScreenParser.ts` is pure-string today and
every one of its tests passes plain strings. Importing xterm there would couple
screen parsing to a terminal engine and make trivial tests need a `Terminal`
instance. Instead `HeadlessTerminal` — which already owns the terminal and
already exposes `getTerminal()` "for cell-level attribute reads (e.g. slash
picker fg color detection)" — produces a small plain-data descriptor, and the
parser consumes plain data. The parser stays trivially unit-testable, and the
xterm dependency stays in exactly one file.

**Design rationale — why an optional parameter, not a new function.** Every
existing caller and test of `parseClaudeComposerState(screen)` keeps working
unchanged. The attribute path is purely additive, and callers with no terminal
access (tests, replayed recordings) degrade to the current behaviour instead of
breaking.

---

### Task 1: `ComposerAttributes` type and attribute-aware classification

**Files:**
- Modify: `packages/claude-code-headless/src/parsers/ScreenParser.ts:45-123`
- Test: `packages/claude-code-headless/src/parsers/ScreenParser.composer.test.ts`

**Interfaces:**
- Produces: `export type ComposerAttributes = { dim: number; inverse: number; plain: number }`
- Produces: `export function parseClaudeComposerState(screen: string, attrs?: ComposerAttributes | null): ClaudeComposerState`

- [ ] **Step 1: Write the failing tests**

Append to `src/parsers/ScreenParser.composer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseClaudeComposerState, type ComposerAttributes } from './ScreenParser.js'

const D = '─'.repeat(40)
const box = (composerRow: string) => [D, composerRow, D].join('\n')

describe('parseClaudeComposerState with cell attributes', () => {
  // WHY these cases: upstream renders EVERY placeholder via chalk.dim and only
  // when the composer value is empty (renderPlaceholder.ts:33-45). So dim
  // content is positive proof of emptiness, whatever the words say. Each string
  // below is real text a live Claude 2.1.215 painted into an empty composer.
  it.each([
    'Press up to edit queued messages',
    'now count backwards from 30 to 1',
    'Message @some-teammate…',
    'write a test for parseClaudeComposerState',
  ])('treats fully dim composer text as empty: %s', text => {
    const attrs: ComposerAttributes = { dim: text.length, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState(box(`❯ ${text}`), attrs)).toBe('empty')
  })

  it('treats the focused placeholder (inverted first char) as empty', () => {
    // Focused composer: invert(placeholder[0]) + chalk.dim(rest).
    const attrs: ComposerAttributes = { dim: 31, inverse: 1, plain: 0 }
    expect(parseClaudeComposerState(box('❯ now count backwards from 30 to 1'), attrs))
      .toBe('empty')
  })

  it('treats any non-dim content cell as a human draft', () => {
    const attrs: ComposerAttributes = { dim: 0, inverse: 0, plain: 26 }
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), attrs))
      .toBe('drafted')
  })

  it('treats a human draft with the cursor mid-text as a draft', () => {
    // The cell under the cursor is inverse; the rest is plain.
    const attrs: ComposerAttributes = { dim: 0, inverse: 1, plain: 25 }
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), attrs))
      .toBe('drafted')
  })

  it('treats a bare marker with no content cells as empty', () => {
    const attrs: ComposerAttributes = { dim: 0, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState(box('❯ '), attrs)).toBe('empty')
  })

  it('returns unpainted when no composer row exists, even with attributes', () => {
    const attrs: ComposerAttributes = { dim: 5, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState('', attrs)).toBe('unpainted')
  })

  it('falls back to string classification when attributes are absent', () => {
    // Callers with no terminal (replayed recordings, existing unit tests) must
    // keep the old behaviour rather than crash or silently flip.
    expect(parseClaudeComposerState(box('❯ this is a real human draft'))).toBe('drafted')
    expect(parseClaudeComposerState(box('❯ Press up to edit'))).toBe('empty')
  })

  it('ignores attributes that describe a different row than the parser found', () => {
    // Defensive: a null descriptor must never be treated as "all dim".
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), null))
      .toBe('drafted')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts
```

Expected: FAIL. TypeScript error that `ComposerAttributes` is not exported, and
`parseClaudeComposerState` accepts only one argument.

- [ ] **Step 3: Implement**

In `src/parsers/ScreenParser.ts`, add the type immediately after
`ClaudeComposerState` (line 45):

```ts
/**
 * Per-frame styling summary of the composer's content cells, produced by
 * HeadlessTerminal.snapshotComposerAttributes().
 *
 * WHY this exists at all: the plain-text screen erases styling, and Claude's
 * placeholder text is arbitrary model-authored prose (prompt suggestions) that
 * is character-for-character indistinguishable from a human draft. The ONLY
 * reliable discriminator is how it is painted.
 *
 * Counts exclude the `❯`/`>` marker itself and every blank cell.
 */
export type ComposerAttributes = {
  /** Cells rendered dim (SGR 2). Upstream paints every placeholder this way. */
  dim: number
  /** Cells rendered as the inverted cursor block (SGR 7). */
  inverse: number
  /** Cells that are neither — i.e. text the human typed. */
  plain: number
}
```

Then change the signature and add the attribute branch. Replace the final
classification block (currently lines 117-122):

```ts
export function parseClaudeComposerState(
  screen: string,
  attrs?: ComposerAttributes | null,
): ClaudeComposerState {
```

…and, keeping all existing marker-location logic untouched, replace the tail:

```ts
  // ATTRIBUTE PATH (authoritative when available).
  //
  // WHY this outranks every string heuristic below: upstream builds the
  // placeholder as chalk.dim(text) — or invert(text[0]) + chalk.dim(rest) when
  // focused — and renders it ONLY when the composer value is empty
  // (vendor/claude-code-src/full/hooks/renderPlaceholder.ts:33-45). So a
  // content cell that is neither dim nor the inverted cursor is, by
  // construction, a character the human typed. This is a structural property of
  // the renderer, not a guess about wording, which is why it survives Claude
  // inventing new placeholder text — the exact drift that broke the allowlist.
  //
  // Note the marker row must already have been located above: if there is no
  // composer at all we return 'unpainted' regardless of styling, because
  // attributes describing a row we did not find prove nothing.
  if (attrs) {
    return attrs.plain > 0 ? 'drafted' : 'empty'
  }

  // STRING FALLBACK for callers with no terminal access (replayed recordings,
  // unit fixtures). Known-incomplete by construction — see ComposerAttributes.
  if (!continuationHasContent && (
    firstLineContent.length === 0 || EMPTY_COMPOSER_HINTS.has(firstLineContent)
  )) {
    return 'empty'
  }
  return 'drafted'
}
```

Also extend the fallback allowlist (defense in depth — it is the path replayed
recordings still take):

```ts
// Known-incomplete by construction: placeholders also include teammate hints
// (user data), example commands (generated from git history), and prompt
// suggestions (model-authored prose). Only the attribute path is complete.
// These two exact strings are proven provider chrome from captured screens.
const EMPTY_COMPOSER_HINTS = new Set([
  'Press up to edit',
  'Press up to edit queued messages',
])
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts
```

Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/ScreenParser.ts src/parsers/ScreenParser.composer.test.ts
git commit -m "fix: classify composer by cell attributes, not placeholder text"
```

---

### Task 2: `HeadlessTerminal.snapshotComposerAttributes()`

**Files:**
- Modify: `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts` (add beside `getTerminal()`, ~line 376)
- Test: `packages/claude-code-headless/src/parsers/ScreenParser.composer.test.ts`

**Interfaces:**
- Consumes: `ComposerAttributes` from Task 1.
- Produces: `snapshotComposerAttributes(): ComposerAttributes | null` — `null` when no composer row is visible.

- [ ] **Step 1: Write the failing test**

Append to `src/parsers/ScreenParser.composer.test.ts`. This drives a real
headless terminal with real ANSI, so it proves the extraction end to end without
needing a live CLI:

```ts
import xtermHeadless from '@xterm/headless'
import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'

// Real SGR sequences, matching what chalk emits upstream.
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`
const INV = (s: string) => `\x1b[7m${s}\x1b[27m`
const RULE = '─'.repeat(60)

describe('HeadlessTerminal.snapshotComposerAttributes', () => {
  function paint(composerRow: string): HeadlessTerminal {
    const term = new HeadlessTerminal({ cols: 80, rows: 12 })
    // \r\n between rows so xterm advances lines the way a PTY would.
    term.writeForTest([RULE, composerRow, RULE].join('\r\n'))
    return term
  }

  it('counts a dim placeholder as dim content with no plain cells', () => {
    const term = paint(`❯ ${DIM('Press up to edit queued messages')}`)
    const attrs = term.snapshotComposerAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!.plain).toBe(0)
    expect(attrs!.dim).toBeGreaterThan(0)
  })

  it('counts a focused placeholder as inverse-first plus dim remainder', () => {
    const term = paint(`❯ ${INV('n')}${DIM('ow count backwards from 30 to 1')}`)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBe(0)
    expect(attrs.inverse).toBe(1)
    expect(attrs.dim).toBeGreaterThan(0)
  })

  it('counts typed text as plain content', () => {
    const term = paint('❯ this is a real human draft')
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBeGreaterThan(0)
    expect(attrs.dim).toBe(0)
  })

  it('returns null when no composer row is painted', () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 12 })
    term.writeForTest('just some output\r\nno composer here')
    expect(term.snapshotComposerAttributes()).toBeNull()
  })

  it('does not count the marker glyph itself as content', () => {
    const term = paint('❯ ')
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs).toEqual({ dim: 0, inverse: 0, plain: 0 })
  })
})
```

**Note for the implementer:** `writeForTest` may not exist. Check
`HeadlessTerminal` for an existing synchronous test-write helper first and use
it. If none exists, add one:

```ts
/** Test-only synchronous write. xterm's write() is async; tests need the
 *  buffer settled before asserting. Not used in production paths. */
writeForTest(data: string): void {
  this.term.write(data)
}
```

If xterm's async write makes assertions flaky, use the callback form
(`this.term.write(data, cb)`) and make the helper return a promise.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts -t snapshotComposerAttributes
```

Expected: FAIL — `snapshotComposerAttributes is not a function`.

- [ ] **Step 3: Implement**

In `src/terminal/HeadlessTerminal.ts`, directly below `getTerminal()`:

```ts
/**
 * Styling summary of the active composer row, or null when no composer is
 * painted.
 *
 * WHY this lives here and not in ScreenParser: ScreenParser is deliberately
 * pure-string so its tests stay trivial, and pulling xterm into it would make
 * "classify a screen" depend on a terminal engine. This file already owns the
 * Terminal and already hands out cell-level reads via getTerminal() (the slash
 * picker's fg-color detection), so cell walking belongs here. We return plain
 * counts rather than the Terminal so the parser consumes serialisable data.
 *
 * WHY the last divider-bracketed box wins: identical to ScreenParser's marker
 * search — an old user-message echo in scrollback must never be mistaken for
 * the live composer. The two searches MUST stay in agreement; if you change one,
 * change both, or the parser will classify a row these counts never described.
 */
snapshotComposerAttributes(): ComposerAttributes | null {
  const buf = this.term.buffer.active
  const top = buf.viewportY
  const bottom = buf.viewportY + this.term.rows - 1

  let markerY = -1
  for (let y = bottom; y >= top && markerY < 0; y--) {
    const line = buf.getLine(y)
    if (!line || !isDividerLine(line.translateToString(true))) continue
    for (let k = y + 1; k <= bottom; k++) {
      const candidate = buf.getLine(k)
      if (!candidate) continue
      const text = candidate.translateToString(true)
      if (isDividerLine(text)) break
      if (/^\s*[❯>](?:\s|$)/u.test(text)) { markerY = k; break }
    }
  }
  if (markerY < 0) return null

  const line = buf.getLine(markerY)
  if (!line) return null

  let dim = 0, inverse = 0, plain = 0, seenMarker = false
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) continue
    const chars = cell.getChars()
    if (!chars.trim()) continue
    // Skip the marker glyph itself — it is chrome, not composer content.
    if (!seenMarker && /[❯>]/u.test(chars)) { seenMarker = true; continue }
    if (cell.isDim()) dim++
    else if (cell.isInverse()) inverse++
    else plain++
  }
  return { dim, inverse, plain }
}
```

Add the imports at the top of the file:

```ts
import { isDividerLine, type ComposerAttributes } from '../parsers/ScreenParser.js'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/terminal/HeadlessTerminal.ts src/parsers/ScreenParser.composer.test.ts
git commit -m "feat: expose composer cell attributes from the headless terminal"
```

---

### Task 3: Wire the attribute path into the live classification

**Files:**
- Modify: `packages/claude-code-headless/src/ClaudeCodeHeadless.ts:549`
- Modify: `packages/claude-code-headless/src/index.ts:77-85`
- Test: `packages/claude-code-headless/src/ClaudeCodeHeadless.conditions.test.ts`

**Interfaces:**
- Consumes: `snapshotComposerAttributes()` (Task 2), `parseClaudeComposerState(screen, attrs)` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `src/ClaudeCodeHeadless.conditions.test.ts`, reusing that file's
existing `fakePty()` helper:

```ts
it('reports an empty composer when the placeholder is dim', async () => {
  // Regression: a dim prompt suggestion used to classify as 'drafted', which
  // made derivePromptGateState return { kind:'occupied' } forever and blocked
  // every prompt. Observed for 186 continuous seconds in session ef052e06.
  const headless = new ClaudeCodeHeadless({ pty: fakePty() })
  await headless.start()

  const rule = '─'.repeat(60)
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`
  headless.writeToTerminalForTest(
    [rule, `❯ ${dim('now count backwards from 30 to 1')}`, rule].join('\r\n'),
  )

  expect(headless.getComposerState()).toBe('empty')
})

it('still reports a drafted composer for typed text', async () => {
  const headless = new ClaudeCodeHeadless({ pty: fakePty() })
  await headless.start()
  const rule = '─'.repeat(60)
  headless.writeToTerminalForTest(
    [rule, '❯ this is a real human draft', rule].join('\r\n'),
  )
  expect(headless.getComposerState()).toBe('drafted')
})
```

**Note for the implementer:** match this file's existing construction and
terminal-write conventions — it already reaches internals via
`headless as unknown as { terminal: ... }`. Use whatever that file already does
rather than inventing `writeToTerminalForTest` if an equivalent exists.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/claude-code-headless
npx vitest run src/ClaudeCodeHeadless.conditions.test.ts
```

Expected: FAIL — first case returns `'drafted'`.

- [ ] **Step 3: Implement**

`src/ClaudeCodeHeadless.ts` line 549:

```ts
this.terminal.on('screen', (snap) => {
  // Pass the per-frame cell-attribute descriptor so placeholder prose (prompt
  // suggestions, queue/teammate hints, example commands) is recognised as an
  // EMPTY composer. Plain text alone cannot distinguish those from a human
  // draft — see ComposerAttributes.
  this.composerState = parseClaudeComposerState(
    snap.plain,
    this.terminal.snapshotComposerAttributes(),
  )
```

`src/index.ts`, extend the existing export block at lines 77-85:

```ts
  parseClaudeComposerState,
  type ClaudeComposerState,
  type ComposerAttributes,
```

- [ ] **Step 4: Run the full submodule suite**

```bash
cd packages/claude-code-headless
npm test
npx tsc -b --pretty false
```

Expected: PASS, clean typecheck. `transcript/JsonlTailer.system.test.ts` is a
known ~2/3 environment flake — rerun it in isolation before blaming this change.

- [ ] **Step 5: Commit**

```bash
git add src/ClaudeCodeHeadless.ts src/index.ts src/ClaudeCodeHeadless.conditions.test.ts
git commit -m "fix: feed composer cell attributes into live classification"
```

---

### Task 4: Edge cases proven unhandled

**Files:**
- Modify: `packages/claude-code-headless/src/terminal/HeadlessTerminal.ts`
- Test: `packages/claude-code-headless/src/parsers/ScreenParser.composer.test.ts`

**Interfaces:** no signature changes.

These three appeared as `drafted` windows in the recording and are *not* covered
by Tasks 1–3. Handle them explicitly rather than assuming.

- [ ] **Step 1: Write the failing tests**

```ts
describe('composer attribute edge cases', () => {
  it('classifies a wrapped dim placeholder as empty', () => {
    // Long suggestions wrap past the marker row. Only the marker row is
    // sampled, so a wrapped placeholder must still read as empty via its
    // first row — assert that explicitly rather than assuming it.
    const term = new HeadlessTerminal({ cols: 40, rows: 12 })
    const long = 'go, full attribute reader and include the recording change'
    term.writeForTest([NARROW_RULE, `❯ ${DIM(long)}`, NARROW_RULE].join('\r\n'))
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBe(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('empty')
  })

  it('classifies the pasted-content marker as a human draft', () => {
    // "[Pasted text #1 +5 lines]" is Claude's own chrome, but it represents
    // content the human actually pasted, so it MUST stay 'drafted'. It is
    // rendered non-dim, so the attribute path gets this right for free —
    // this test locks that in.
    const term = new HeadlessTerminal({ cols: 80, rows: 12 })
    term.writeForTest([RULE, '❯ [Pasted text #1 +5 lines]', RULE].join('\r\n'))
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBeGreaterThan(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('drafted')
  })

  it('does not mistake a trust-dialog menu row for a composer draft', () => {
    // '❯ 1. Yes, I trust this folder' matches the marker regex. Conditions are
    // checked before the composer in derivePromptGateState so this is latent
    // today, but it is the same class of bug and must not regress.
    const term = new HeadlessTerminal({ cols: 80, rows: 12 })
    term.writeForTest('Do you trust the files in this folder?\r\n❯ 1. Yes, I trust this folder')
    // No divider box: there is no active composer here.
    expect(term.snapshotComposerAttributes()).toBeNull()
  })
})
```

Define `const NARROW_RULE = '─'.repeat(30)` alongside `DIM`/`INV`/`RULE` at module
scope in that file (they are declared above the first `describe`, so all blocks
share them), and use `NARROW_RULE` in the wrapped-placeholder case above in
place of `RULE40`.

- [ ] **Step 2: Run the tests**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts -t "edge cases"
```

Expected: the wrapped and pasted cases likely PASS already (they fall out of the
design); the trust-dialog case may FAIL if the marker search accepts a row with
no enclosing divider box.

- [ ] **Step 3: Fix only what actually failed**

If the trust-dialog case fails, the marker search is falling back too eagerly.
Require the enclosing divider box in `snapshotComposerAttributes` — it already
does, so returning `null` is correct; if instead the string parser's
compatibility scan (`ScreenParser.ts:90-98`) is the culprit, leave it alone. It
is the fallback path only, and conditions gate it in production. Do not
restructure the string parser in this PR.

- [ ] **Step 4: Verify**

```bash
cd packages/claude-code-headless
npx vitest run src/parsers/ScreenParser.composer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/parsers/ScreenParser.composer.test.ts src/terminal/HeadlessTerminal.ts
git commit -m "test: lock in composer edge cases for wrap, paste, and trust rows"
```

---

### Task 5: Bounded-staleness escape hatch for the prompt gate

**Files:**
- Modify: `agent-code/src/providers/claude/runtime/claudeSession.ts:744-765`
- Test: `agent-code/src/providers/claude/runtime/claudeSession.promptAcceptance.test.ts`

**Interfaces:** no signature changes.

**Scope note.** This is defense in depth, not the root-cause fix. It is included
because the observed failure was a *permanent* lockout with no recovery path:
`occupied` is evaluated before the warming check and nothing re-opens it. If you
want the minimal PR, drop this task — Tasks 1–4 fix the actual bug. Recommended
to keep.

- [ ] **Step 1: Write the failing test**

```ts
it('does not report occupied forever when the composer reads drafted', async () => {
  // Regression: a misread composer produced { kind:'occupied' } that never
  // cleared, pinning the UI at "Starting agent" for 186s with no recovery.
  // Whatever the composer says, a gate that has been occupied beyond the
  // staleness bound must degrade to warming so readiness can be re-derived.
  const session = makeSessionWithComposer('drafted')
  session.markTranscriptAttachedForTest()
  vi.advanceTimersByTime(OCCUPIED_STALENESS_MS + 1)
  expect(session.derivePromptGateStateForTest().kind).not.toBe('occupied')
})
```

**Note for the implementer:** this file constructs sessions its own way and
reaches privates directly. Follow its existing conventions; the helper names
above are illustrative, not prescriptive. If exposing `derivePromptGateState`
for test requires an awkward seam, prefer asserting on the emitted
`prompt-gate` / `input-readiness` events instead.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/composer-placeholder-detection
npx vitest run src/providers/claude/runtime/claudeSession.promptAcceptance.test.ts
```

- [ ] **Step 3: Implement**

In `claudeSession.ts`, add near the other timing constants:

```ts
// WHY a bound at all: 'occupied' is derived from a screen heuristic, and a
// wrong reading is unrecoverable by construction — the user cannot clear a
// draft that does not exist, and nothing else re-opens the gate. Observed
// 2026-07-19: 186 continuous seconds of blocked delivery from one misread.
// Past this bound we degrade to 'warming' so readiness can be re-derived and
// the session becomes usable again. Correctness still comes from the composer
// attribute fix in claude-code-headless; this only bounds the blast radius of
// any future misread.
const OCCUPIED_STALENESS_MS = 10_000
```

Track when the gate first became occupied and consult it in
`derivePromptGateState` (lines 758-759):

```ts
const composer = this.headless.getComposerState()
if (composer === 'drafted') {
  if (this.occupiedSince === null) this.occupiedSince = Date.now()
  if (Date.now() - this.occupiedSince < OCCUPIED_STALENESS_MS) {
    return { kind: 'occupied', reason: 'human-draft' }
  }
  // Fall through: treat a long-lived 'drafted' as a warming signal instead of
  // a permanent block.
} else {
  this.occupiedSince = null
}
```

Declare `private occupiedSince: number | null = null` beside the other gate
fields, and reset it wherever the gate resets.

- [ ] **Step 4: Verify**

```bash
npx vitest run src/providers/claude/runtime/claudeSession.promptAcceptance.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/claude/runtime/claudeSession.ts src/providers/claude/runtime/claudeSession.promptAcceptance.test.ts
git commit -m "fix: bound how long the Claude prompt gate can report occupied"
```

---

### Task 6: Live PTY test (the drift detector)

**Files:**
- Create: `packages/claude-code-headless/test/live/composerDetection.live.test.ts`
- Reference: `agent-code/temp/detect-live.mts` (the validated probe this is derived from)

**Interfaces:** none — end-to-end test.

**Why this task exists.** Every existing test feeds hand-written strings, so the
suite can only prove we handle strings someone already imagined. The bug was
*upstream drift* — Claude changed its placeholder text. Only a test that runs
the real CLI can catch the next one. The `.live` tier already exists
(`vitest.live.config.ts`, `npm run test:live`) and is completely empty.

**This test is excluded from CI by design** — it needs auth, network, and a real
`claude` on PATH, and takes ~60s. It is a drift detector you run deliberately,
e.g. after a Claude Code upgrade.

- [ ] **Step 1: Confirm the live tier picks up the file**

```bash
cd packages/claude-code-headless
cat vitest.live.config.ts
```

Confirm the `include` covers `test/live/**`. If it only covers
`src/**/*.live.test.ts`, place the file at
`src/parsers/composerDetection.live.test.ts` instead.

- [ ] **Step 2: Write the test**

```ts
import { describe, expect, it } from 'vitest'
import { spawn } from 'node-pty'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessTerminal } from '../../src/terminal/HeadlessTerminal.js'
import { parseClaudeComposerState } from '../../src/parsers/ScreenParser.js'

// Drives a REAL `claude` CLI and asserts the composer classification against
// states we force. This is the only test that can detect upstream changing its
// placeholder rendering — the exact failure that shipped on 2026-07-19.
describe('live composer detection', () => {
  it('classifies a real dim placeholder as empty and typed text as drafted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'composer-live-'))
    const term = new HeadlessTerminal({ cols: 120, rows: 40 })
    const pty = spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', 'claude'], {
      name: 'xterm-256color', cols: 120, rows: 40, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
    pty.onData(d => term.writeForTest(d))
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const classify = () =>
      parseClaudeComposerState(term.snapshotPlain(), term.snapshotComposerAttributes())

    try {
      // A fresh temp cwd always shows the folder-trust dialog first.
      await sleep(6000)
      if (/trust (the )?(files|this folder)/i.test(term.snapshotPlain())) {
        pty.write('1\r')
        await sleep(7000)
      }
      for (let i = 0; i < 25 && !/─{10}/.test(term.snapshotPlain()); i++) await sleep(1000)

      expect(classify()).toBe('empty')

      pty.write('this is a real human draft')
      await sleep(2000)
      expect(classify()).toBe('drafted')

      for (let i = 0; i < 80; i++) pty.write('\x7f')
      await sleep(800)
      expect(classify()).toBe('empty')

      // Run a turn so Claude offers a prompt suggestion, which it renders as a
      // dim placeholder over an EMPTY composer. This is the regression case.
      pty.write('count slowly from 1 to 30, one number per line\r')
      await sleep(30000)

      const attrs = term.snapshotComposerAttributes()
      if (attrs && attrs.dim > 0) {
        // A placeholder is showing: it MUST classify empty despite having text.
        expect(attrs.plain).toBe(0)
        expect(classify()).toBe('empty')
      }
      // If no suggestion appeared this run, the earlier assertions still stand.
    } finally {
      pty.kill()
    }
  }, 120_000)
})
```

- [ ] **Step 3: Run it**

```bash
cd packages/claude-code-headless
npm run test:live
```

Expected: PASS. Requires `claude` on PATH and working auth.

- [ ] **Step 4: Commit**

```bash
git add test/live/composerDetection.live.test.ts
git commit -m "test: add live PTY drift detector for composer classification"
```

- [ ] **Step 5: Open the submodule PR**

```bash
gh auth status   # MUST be Juliusolsson05
git push -u origin fix/composer-placeholder-detection
gh pr create --title "fix: classify the composer by cell attributes, not placeholder text" --body "$(cat <<'EOF'
## Problem

`parseClaudeComposerState` read the composer as plain text and classified any
unrecognised string as `drafted`, failing closed against a one-entry allowlist.
Agent Code maps `drafted` to a non-ready prompt gate, so the agent pinned at
"Starting agent" and every prompt was rejected with "occupied by a human draft".

Measured on a real session: 1,114 of 2,588 screens (43%) misclassified, one
continuous 186.8-second block, zero readiness events.

The allowlist cannot be completed. Claude renders four kinds of placeholder,
three of them unbounded — teammate names (user data), example commands
(generated from git history), and prompt suggestions (model-authored prose).

## Fix

Upstream renders every placeholder via `chalk.dim`, and only when the composer
value is empty (`renderPlaceholder.ts:33-45`). So a content cell that is neither
dim nor the inverted cursor is, by construction, text the human typed.

`HeadlessTerminal.snapshotComposerAttributes()` extracts per-frame counts;
`parseClaudeComposerState` takes them as an optional second argument and prefers
them over string matching. Existing single-argument callers are unaffected.

## Verification

Live `claude` 2.1.215 PTY, 8 forced states: string parser wrong on 2/8,
attribute detector wrong on 0/8. Both failures were dim placeholders
(`dim=26 plain=0`) over an empty composer.

Adds a `.live` drift detector — the tier existed and was empty. It runs the real
CLI, so it can catch the next upstream placeholder change. Excluded from CI.

Regression introduced by #39 (`46630ae`).
EOF
)"
```

**Stop here.** Do not merge. Report back with the PR URL.

---

### Task 7: Gitlink bump in `agent-code`

**Files:**
- Modify: `agent-code` gitlink for `packages/claude-code-headless`

**Interfaces:** consumes the merged submodule commit from Task 6.

**Ordering constraint:** this can only happen after the submodule PR merges.
Until then `agent-code` still pins the broken parser, and no amount of local
testing in this worktree reflects what ships.

- [ ] **Step 1: Point the submodule at the merged commit**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/composer-placeholder-detection/packages/claude-code-headless
git fetch origin
git checkout main && git pull
cd ..
```

- [ ] **Step 2: Verify the full gate**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/composer-placeholder-detection
npx tsc -b --pretty false
npm test
```

Expected: clean typecheck, suite green. Per repo convention `tsc -b` is the only
type gate — neither the build nor Vitest type-checks.

- [ ] **Step 3: Commit the bump**

```bash
git add packages/claude-code-headless
git commit -m "chore: bump claude-code-headless for composer attribute detection"
```

- [ ] **Step 4: Manual verification in the real app**

```bash
npm run dev
```

Confirm: start an agent, let it run a turn, and when Claude offers a dim prompt
suggestion the composer stays usable — no "Starting agent" pin, no "occupied by
a human draft" on send.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin fix/composer-placeholder-detection
gh pr create --title "fix: stop reading Claude's dim placeholder as a human draft" --body "$(cat <<'EOF'
## Summary

Bumps `claude-code-headless` to pick up attribute-based composer classification,
and bounds how long the Claude prompt gate can report `occupied`.

Without the bump, Agent Code still pins the broken parser — the submodule PR
must merge first.

## Why the escape hatch

`occupied` was evaluated before the warming check and nothing re-opened it, so a
single misread was unrecoverable: the user cannot clear a draft that does not
exist. Observed as 186 continuous seconds of blocked delivery. Past a staleness
bound the gate now degrades to `warming` so readiness can be re-derived.

Correctness comes from the submodule fix; this only bounds the blast radius of
any future misread.

## Verification

- `tsc -b` clean, suite green
- `npm run dev`: prompt delivery survives a live dim prompt suggestion
EOF
)"
```

**Stop here. Do not merge.**

---

## Verification Checklist

- [ ] `parseClaudeComposerState` returns `empty` for dim placeholder text regardless of wording
- [ ] `parseClaudeComposerState` returns `drafted` for any non-dim content cell
- [ ] Existing single-argument callers are unchanged in behaviour
- [ ] `npx tsc -b` clean in both repos
- [ ] `npm test` green in both repos (JsonlTailer flake excepted)
- [ ] `npm run test:live` passes against real `claude`
- [ ] Manual `npm run dev`: prompt delivery survives a live prompt suggestion
- [ ] Submodule PR merged **before** the gitlink bump PR

## Out of Scope

Found during investigation, deliberately excluded:

- **Proxy attribution leak** — a `claude` spawned from a tool call inherits the
  proxy env and its flows are attributed to the parent session. Confirmed: a
  throwaway probe's suggestion appeared in session `ef052e06`'s recording.
- **~50 orphaned `workspace.json.*.tmp`** files in `~/.config/agent-code` dating
  to May — the atomic write path does not clean up temps on failure.
- **Recording format** — screen recordings persist `plain` only, so historical
  recordings cannot exercise the attribute path. Not needed: the live tier
  covers drift, and unit tests cover the logic.
- **String-parser restructuring** — the fallback stays known-incomplete on
  purpose. Only the attribute path is complete.
