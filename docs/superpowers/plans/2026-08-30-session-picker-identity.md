# Session Picker Identity

> Fixes #96

## Outcome

Give a past conversation **one identity**, derived once, rendered the same way
everywhere the user can pick one — so that "which past conversation is this?" has
a single answer regardless of whether the user arrived via resume, the command
palette, or prompt search.

The end state: one typed record, one row component, one fallback ladder, and a
fallback that *looks* like a fallback instead of masquerading as a title.

## Why #96's own diagnosis is incomplete

The issue frames this as a **display-layer** problem — "at least three modals"
that each render the same thing differently — and proposes unifying the
renderer. That framing is right about the symptom and wrong about the cause, and
building only what the issue sketches would leave the bug half-fixed.

The identity decision is not made in the renderer. **It is made in the provider
listers, and it is flattened into a lossy `summary: string` before the UI ever
sees it.** Three findings from reading the current code:

### 1. Claude and Codex name the same conversation differently

| | Claude — `src/providers/claude/runtime/sessionList.ts:353` | Codex — `packages/codex-headless/src/transcript/SessionList.ts:262` |
|---|---|---|
| `summary` = | `customTitle ?? lastPrompt ?? firstPrompt` | `userText ?? replayUserText` (the **first** user message) |

Claude labels a session by its **last** prompt; Codex by its **first**. The same
work, moved between providers — which this app supports as a headline feature —
changes its own name. No renderer change can reconcile that, because by the time
the row is painted both are just strings.

### 2. The hex ID the issue complains about is baked in *below* the UI

`SessionList.ts:250` and `:264` in `codex-headless`:

```ts
if (!meta && !userText && !replayUserText) {
  return { sessionId: file.sessionId, summary: file.sessionId.slice(0, 8), … }
}
…
if (!summary) summary = file.sessionId.slice(0, 8)
```

The truncated hex ID is written **into the `summary` field**. A renderer
receiving that string cannot tell a real title from a fallback, so #96's own
requirement — *"The fallback should be visible (e.g. italicised) so the user
knows they're looking at a fallback identity"* — is **unimplementable** against
the current contract. This is the single most important reason the fix cannot be
renderer-only.

### 3. The two providers disagree on whether a nameless session exists at all

`sessionList.ts:354` (Claude): `if (!summary) return null` — the session is
**dropped from the list**. Codex, above, **shows it** with a hex label. So the
providers differ not just in labelling but in list *membership*. A Claude session
with no derivable summary is invisible in the resume picker.

### The real root cause

> The fallback policy is encoded as a **lossy string at the provider boundary**,
> independently by each provider, and the renderer is handed the result with no
> way to recover what it was looking at.

Unify the renderers alone and all three defects above survive intact.

## The current shape, as measured

Two independent listing paths, and neither knows about the other.

**Path A — `SessionInfo`** (`src/shared/types/session.ts:520`) feeds the two
*resume* surfaces:

- Claude: `src/providers/claude/runtime/sessionList.ts` — **app-side**, and a
  near-duplicate of the dormant `packages/claude-code-headless/src/transcript/SessionList.ts`
- Codex: `listCodexSessions` from the `codex-headless` submodule, dispatched at
  `src/providers/registry.main.ts:71`
- Fields: `sessionId`, `summary`, `lastModified`, `fileSize`, `customTitle?`,
  `firstPrompt?`, `gitBranch?`, `cwd?`, `createdAt?` — **no `kind`**

**Path B — `SessionIndexEntry`** (`src/main/sessionIndex.ts:50`, and duplicated
verbatim at `src/preload/api/types.ts:252`) feeds *prompt search*:

- `sessionIndex.ts` does its **own** transcript parsing for both providers
  (`extractClaudePromptsAndCwd`, `extractCodexPromptsAndCwd`), and *also* calls
  the Claude lister for discovery (`:147`)
- Fields: `providerSessionId`, `kind`, `cwd`, `lastModified`, `summary`,
  `recentUserPrompts[]`, `matchCount` — **no `customTitle` / `gitBranch`**

The same field is called `sessionId` in one and `providerSessionId` in the other.
`SessionInfo`'s own doc comment claims to be the source of truth for "renderer
resume UI" while Path B serves a different picker with a different shape.

Counting transcript-reading implementations: the app-side Claude lister, the
Codex submodule lister, `sessionIndex`'s own dual-provider parser, and a dormant
fourth copy inside `claude-code-headless`. **Three live, one dead.**

### Three surfaces, three renderings — verified in the JSX

| Surface | Primary line | ID shown |
|---|---|---|
| `PathPickerModal.tsx:405` | `session.summary` | **always**, `sessionId.slice(0, 8)` |
| `CommandPalette.tsx:2072` | `summary \|\| firstPrompt \|\| sessionId` | on fallback, **full untruncated** |
| `PromptSearchModal.tsx:386` | `providerGlyph(kind)` + `cwdBasename(cwd)` + prompt lines | never |

The first two consume the *same* `SessionInfo` and still disagree.
`sessionDisplay.ts` is 35 lines holding `cwdBasename` and `providerGlyph`, and
its header explicitly declines to become the canonical formatter; neither resume
surface imports it. **No test anywhere pins display consistency.**

## Corrected scope: three surfaces, not four

#96 lists four modals. Two of them have a different job and must be **dropped
from scope**:

- **`ViewPromptsModal`** takes a `sessionId` prop and reads
  `workspace.state.sessions[sessionId]` — it lists prompts *inside one already
  open session*.
- **`RewindToPromptModal`** likewise picks a rewind target within the current
  session.

Neither displays a session identity, because the user already knows which session
they are in. They are **prompt pickers**, not **session pickers**. Forcing them
onto a shared session-row component would be a regression dressed as consistency.

The surfaces in scope are the three that answer *"which past conversation is
this?"*:

1. `PathPickerModal` resume list
2. `CommandPalette` session list — **not inventoried by #96**; it postdates the
   issue and is the reason this keeps getting worse
3. `PromptSearchModal`

## Design

### 1. The record

```ts
/** One past conversation, as a picker must display it. Derived once in main;
 *  never re-derived in the renderer. */
export type SessionDisplayIdentity = {
  providerSessionId: string
  kind: AgentProviderKind
  cwd: string | null

  /** The label to show, already resolved through the ladder below. */
  label: string
  /** WHERE `label` came from. This is the field that makes the fallback
   *  visible, and the reason a flattened `summary: string` cannot work. */
  labelSource: 'custom-title' | 'first-prompt' | 'last-prompt' | 'cwd' | 'session-id'

  lastActivityAt: number
  /** Absent when the provider lister cannot cheaply count. Never faked to 0. */
  turnCount: number | null
  gitBranch: string | null
}
```

`labelSource` is the load-bearing field. Everything else is convenience;
`labelSource` is what lets a row italicise a fallback, lets a test assert the
ladder, and lets us delete the "is this string secretly a hex id?" guesswork.

### 2. One fallback ladder, provider-independent

```
custom-title → first-prompt → last-prompt → cwd basename → truncated session id
```

Two deliberate departures from today:

- **`first-prompt` outranks `last-prompt`.** #96 asks for "most recent prompt"
  first, and Claude currently prefers `lastPrompt`. Both are wrong for
  recognition: users remember a conversation by *how it started*. Codex already
  does this. Adopting first-prompt everywhere also makes a provider switch
  identity-preserving, which is a headline feature of this app.
- **A nameless session is never dropped.** Claude's `return null` disappears;
  it falls to `cwd` and then `session-id`, both marked as fallbacks.

This is a **visible behaviour change** to Claude session labels — sessions with a
`lastPrompt` will re-label to their first prompt. That is the point of the issue,
but it must be called out in the PR, not smuggled in.

### 3. One row component

`SessionPickerRow` under `src/renderer/src/features/workspace/ui/`, consuming
`SessionDisplayIdentity`. It owns: provider glyph, label (italicised when
`labelSource` is `cwd` or `session-id`), project basename, relative last activity,
turn count when present. The truncated id appears **only** as a fallback label,
never as a permanent second line.

Prompt search keeps its extra prompt-list body — it composes `SessionPickerRow`
as its header rather than replacing it. Consistency of *identity*, not
flattening of every list into the same thing.

### 4. Where it is derived

In main, at the registry boundary, so both providers pass through one ladder:

- Extend the `registry.main.ts` provider lister contract to return the fields the
  ladder needs (`firstPrompt`, `customTitle`, `turnCount`) **without** a
  pre-flattened `summary`.
- Apply the ladder once in a new `src/main/sessionDisplayIdentity.ts`.
- Serve it over one IPC. `SessionIndexEntry` keeps `recentUserPrompts` and gains
  an embedded `identity`; the two shapes stop competing over who names a session.

### 5. The Codex submodule problem, and the v1 bridge

The `summary = sessionId.slice(0,8)` fallback lives in **`codex-headless`**, a
separate repository. Doing this correctly means a PR there, a submodule bump, and
a lockfile resync — a cross-repo dependency that would block all UI work behind
an upstream merge.

**v1 bridges it in-app instead.** At the registry boundary, if a Codex
`summary === sessionId.slice(0, 8)`, treat it as absent and let the ladder
proceed. This is a heuristic, and it is a *sound* one: we control both sides of
the comparison, and a user whose first prompt is exactly the 8 leading hex
characters of their own rollout id is not a case worth engineering for. It must
carry a comment saying it is a bridge and what replaces it.

**v2** (separate, non-blocking): teach `codex-headless` to return
`{ label, labelSource }` and delete the bridge. Same for the dormant
`claude-code-headless` lister if it is ever revived — or delete that file, since
the app has not used it since the app-side fork.

## Stages

Each stage merges on its own and leaves the app working. #96 asks for
one-modal-at-a-time; this keeps that, with the data work first because the
renderer cannot be fixed without it.

**Stage 1 — the record and the ladder (no UI change).**
`SessionDisplayIdentity` in `@shared/types`, the ladder in
`src/main/sessionDisplayIdentity.ts`, the registry-contract widening, the Codex
bridge. Unit tests for the ladder: one case per rung, plus the Codex hex bridge,
plus "a nameless Claude session is no longer dropped". Nothing renders it yet.

**Stage 2 — `SessionPickerRow` + PromptSearchModal.**
Build the component; migrate the surface already closest to the target. Renderer
test: a `cwd`-sourced label renders as a visible fallback, a `custom-title` one
does not.

**Stage 3 — CommandPalette.**
The highest-traffic picker and the one that currently leaks a full raw session
id. Migrating it deletes the `summary || firstPrompt || sessionId` chain.

**Stage 4 — PathPickerModal resume list.**
Deletes the permanent `sessionId.slice(0, 8)` second line — the literal thing
#96 was filed about.

**Stage 5 — consolidation and the consistency test.**
Delete `SessionIndexEntry`'s duplicated definition in `preload/api/types.ts`.
Add the test that keeps this closed: **every session picker renders identity
through `SessionPickerRow`** — a narrow filesystem-scanning boundary test in the
style of `src/providers/importBoundaries.test.ts`, asserting no picker reads
`.summary` or `.sessionId` for display. One test, clear failure message, no new
tooling — matching the repo's anti-enforcement-bloat convention.

## Verification

- Ladder unit tests, one per rung, plus provider-parity: the same recorded
  conversation yields the same `label` and `labelSource` under both providers.
- Renderer tests for fallback visibility.
- The Stage 5 boundary test as the regression lock.
- `npm run typecheck` (both projects), `npm run test:renderer`, `npm run check`
  before the final merge.

## Risks and non-goals

- **Claude labels will visibly change** (last-prompt → first-prompt). Intended;
  must be stated in the PR body.
- **Sessions previously invisible will appear** in Claude resume lists once
  `return null` is removed. Also intended — a session you cannot see is worse
  than one labelled by its folder.
- **Not in scope:** `ViewPromptsModal`, `RewindToPromptModal` (different job, see
  above); `sessionIndex.ts`'s whole-file scan performance, which is #94's
  territory and must not be conflated with identity; any change to how resume
  itself *works* — this is purely how a session is *presented* before resuming.
- **`sessionDisplay.ts`** keeps `cwdBasename` / `providerGlyph` as primitives.
  `SessionPickerRow` consumes them; they do not become the identity layer.
