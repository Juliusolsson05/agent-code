# Reply to Selection

> **Status:** shipped. Implementation lands in the same PR as this file; §4 and
> §5 were amended mid-implementation where the code disagreed with the plan
> (both amendments are marked inline).
>
> Highlight text in a session feed, run a command, and the composer draft is
> prefixed with that text wrapped in an XML tag so the agent knows exactly what
> the user is replying to.

---

## 1. The user story

The user is reading a session feed. They drag-select a sentence, a stack frame,
a filename — anything visible. They open the command palette and run
**Reply to Selection**. The composer draft becomes:

```
<quoted-from-conversation note="The user selected this text from the conversation above and is replying to it.">
the text they highlighted
</quoted-from-conversation>

whatever they had already typed
```

Nothing is sent. Insertion stops at the draft boundary, exactly like prompt
template insertion does today (`CommandPalette.tsx` `executePromptTemplate`).
The user still hits Enter themselves.

## 2. Why this is not a five-line feature

Two constraints force almost every decision below.

### 2.1 Opening the command palette destroys the selection

The palette is an input. Focusing it makes Chrome collapse the document
selection. So a `when:` guard that calls `window.getSelection()` at
palette-render time sees nothing, and by the time `run()` executes there is
certainly nothing left.

**Therefore the selection cannot be read at command time.** It has to be
captured *continuously*, while the user is still dragging, into a stash that
the command reads afterwards. This inverts the obvious design and is the single
load-bearing fact in this document. Anyone who "simplifies" this back to
reading the live selection inside `run()` will ship a command that silently
inserts nothing.

### 2.2 A stash can outlive the highlight the user sees

Once the truth lives in a stash instead of the DOM, the stash and the visible
highlight can disagree. The failure mode is: the user clicks somewhere, the
highlight disappears, the command is still armed, and it inserts text the user
no longer believes is selected.

So the stash needs an eviction rule, and the rule has to distinguish two
collapse causes that look identical to a naive `selectionchange` handler:

| Collapse cause | What the user meant | Stash |
| --- | --- | --- |
| Click inside the feed | "I'm done with that selection" | **clear** |
| Focus moved to the palette / composer | "I'm about to use it" | **keep** |

The discriminator: on `selectionchange`, only clear when the new collapsed
selection's anchor is *still inside a quote scope*. Palette focus moves the
anchor out of the scope (or drops it entirely), so it fails that test and the
stash survives. This is the whole trick, and it is five lines.

## 3. Scope anchoring

We need to know *which session's feed* a selection came from, and we need to
exclude the composer and pane chrome. Neither existing anchor works:

- `[data-pane-id]` (`TileLeaf.tsx:549`) wraps the **whole pane** — header,
  feed, and composer. Selecting inside the composer would register as a
  quotable feed selection.
- Reader Mode is a **full takeover** (`MainSurface` renders `ReaderView`
  *instead of* the workspace shell — see the note at `TileLeaf.tsx:172-174`), so
  no `TileLeaf` and no `data-pane-id` exists there at all.

So this feature introduces its own anchor: **`data-quote-scope={sessionId}`**,
stamped on exactly the regions whose text is quotable.

- `Feed.tsx` — on the scroller root (the element that already carries
  `h-full overflow-auto @container`).
- `ReaderView.tsx` — on the message body container.

A dedicated attribute rather than reusing `data-pane-id` means the quotable
region is declared, not inferred, and Reader Mode participates by stamping one
attribute instead of growing a parallel code path.

### 3.1 Regions that stay unquotable

`select-none` is already set on markers, block headers, and summaries
(`ui/MarkerRow.tsx`, `ui/rows/Block.tsx`, `ui/semantic/BlockRow.tsx`). Those are
chrome, not content, and we **leave them alone**. Loosening them is a change to
the rendering pipeline, which carries a test-first discipline
(`docs/rendering/rendering-design-principles.md`) that this PR should not drag
in. Consequence to accept knowingly: a drag spanning a block header yields text
with that header missing. That is the correct outcome anyway.

## 4. Design decisions

Each of these was chosen over a named alternative.

| # | Decision | Rejected alternative | Why |
| --- | --- | --- | --- |
| 1 | **XML tag** wrapper | `User replied to this: …`, markdown blockquote | Quoted feed text is frequently code or markdown, which corrupts both plainer forms. The repo already establishes tag-the-model convention (`<stt>` in `MANIFESTO.md`). |
| 2 | Clear on use + on in-scope collapse | Clear on any collapse; never clear | See §2.2 — clearing on *any* collapse breaks the one flow the feature exists for. |
| 3 | Second run **replaces** the quote | Stack quotes; refuse | Running it twice is a mis-fire correction far more often than an intent to quote two things. "Top of the composer" is one slot. |
| 4 | Agent panes + Reader Mode | Grid only; include terminals | Reader Mode is where long-session reading happens — peak "I want to reply to this line". Terminals use xterm's own selection model and would need a second implementation. |
| 5 | Cap at 2000 chars, middle-ellipsis, toast says so | No cap; refuse when long | A stray Cmd+A must not dump a session into the composer. Visible truncation beats silent truncation and beats a dead-end refusal. |
| 6 | Palette only, no keybinding | Add a chord | Explicitly dropped by the user. Nothing in the design depends on it; a chord can be added later without touching the capture layer. |
| 7 | Stable title, snippet in a `getState` badge | Snippet in the title or description | `docs/command-style.md` rule 1 wants stable noun phrases as titles, and rule 3 says show state as a short badge. `CommandDef.description` is typed as a plain `string` (not a function of context), so it *cannot* carry a dynamic snippet — `getState` is the mechanism the palette already has for exactly this. |
| 8 | No source attribution | Record assistant-vs-user role in the tag | Would require mapping a DOM range back to a transcript entry. The model already knows what it said. YAGNI for v1. |

## 5. Module layout

New feature directory, following the established
`features/<name>/{lib,commands}` shape:

```
src/renderer/src/features/reply-to-selection/
  lib/quoteScope.ts        — the data-quote-scope attribute + DOM resolution
  lib/selectionStash.ts    — module-scope stash, a single slot
  lib/formatQuote.ts       — pure: truncate, wrap in the tag, prefix a draft
  useSelectionCapture.ts   — the single document-level selectionchange listener
  commands/replyToSelectionCommands.ts
```

**Why a single slot and not a Map keyed by session.** *(Found during
implementation; the first draft of this plan said "one entry per session".)*
A document has exactly one selection. If the user selects in pane A and then in
pane B, A's highlight is gone from the screen — a per-session Map would keep
offering a quote the user can no longer see, which is the exact confusion §2.2
exists to prevent.

It also fixes a targeting bug the Map version had. The obvious implementation
resolves the target from `commandTargetSessionId`, but that follows grid /
Dispatch focus, and **Reader Mode maintains its own session selection**
(`workspace.setReaderModeSession`). Quoting in Reader Mode would have inserted
into whichever session the hidden grid happened to be focused on. Carrying the
session id *inside* the stash makes the target unambiguous: it is the session
whose feed the text came from, by construction. The command therefore never
calls `commandTargetSessionId` at all — it validates the stashed session
against current state (still open, not a terminal) instead.

**Why a module-scope stash and not `SessionRuntime`.** `draftInput` lives in
runtime because it must survive `TileLeaf` unmount and be persisted as a draft.
A pending selection is neither: it is ephemeral, DOM-derived, and must never be
autosaved or rehydrated. Putting it in runtime would additionally push it
through `setDraftVersion`, dirtying the autosave path on every mouse drag.
`codeBlockRegistry.ts` sets the precedent for DOM-derived data living in a
module Map, and the reactivity we would gain from runtime is not needed —
the palette evaluates `when:` when it builds its list, which is always *after*
the selection was made.

**Why one document-level listener and not one per pane.** `selectionchange`
only fires on `document`; there is no element-scoped version. A per-pane hook
would mean N listeners all filtering the same global event. One listener that
resolves the owning scope via `closest('[data-quote-scope]')` is strictly less
work and makes Reader Mode free.

## 6. Data flow

```
user drags in a feed
  → document 'selectionchange'
  → useSelectionCapture: resolve anchor → closest('[data-quote-scope]')
      non-empty + in scope → stash.set(sessionId, text)
      collapsed + still in scope → stash.clear(sessionId)
      collapsed + out of scope (palette focus) → leave stash alone
  → user opens palette
  → command `when:` → stash.peek() validated against workspace state
  → run(): { sessionId, text } = stash.take()   // read-and-clear
           draft = workspace.getRuntime(sessionId).draftInput
           workspace.setDraftInput(sessionId, prefixDraftWithQuote(draft, text))
           workspace.showPaneToast(sessionId, …)
```

`stash.take` is read-and-clear in one call so decision 2's "consume on use" and
decision 3's replace semantics cannot drift apart.

## 7. Error handling

| Case | Behavior |
| --- | --- |
| Stash empty | Command does not appear (`when:` false). Not an error. |
| Stashed session was closed | `when:` returns false; `run()` re-validates before consuming, in case the session closed while the palette was open. |
| Stash exists but pane unmounted | `setDraftInput` still valid — runtime outlives the pane. Insert succeeds. |
| Drag spans two panes | Both ends must resolve to the *same* scope, otherwise nothing is stashed. |
| Selection is only whitespace | Treated as empty; never stashed. |
| Selection exceeds 2000 chars | Truncated with a middle ellipsis; toast states it was truncated. |
| Draft already starts with a quote block | Replaced, not stacked (decision 3). |
| Target session is a terminal | Excluded by the same `focusedAgentSessionId` guard the prompt-template commands use. |

## 8. Testing

Per the standing "no new test files in feature PRs" convention, this PR ships
no new `*.test.ts`. The pure core (`formatQuote.ts`) is written so it *can* be
covered later without touching the DOM — truncation, wrapping, and
replace-existing are all total functions of `(draft, text)`.

Manual verification for this PR:

1. Select text in a grid pane feed → palette shows **Reply to Selection** with
   the snippet in its description → run → draft is prefixed, nothing sent.
2. Type a draft first, then select and run → the typed draft survives below the
   quote block.
3. Run twice with two different selections → one quote block, the second.
4. Select, then click elsewhere in the feed → command disappears.
5. Select, open palette, close it, reopen → command still there (§2.2).
6. Select in Reader Mode → quote lands in that session's draft.
7. Select inside the composer → command does **not** appear.

Verification gate: `tsc` on both projects (the electron-vite build and vitest
do not type-check).

## 9. Implementation order

1. `lib/quoteScope.ts`, `lib/selectionStash.ts`, `lib/formatQuote.ts` — pure,
   no consumers yet.
2. Stamp `data-quote-scope` in `Feed.tsx` and `ReaderView.tsx`.
3. `useSelectionCapture.ts`, mounted once in `App.tsx`.
4. `commands/replyToSelectionCommands.ts`, registered in
   `command-palette/registry.ts` next to `promptTemplateCommands` (registry
   order is the palette's browse order — this belongs with the other
   composer-insertion commands).
5. `tsc` both projects.
