# Prompt Template Preview Panel

**Date:** 2026-07-20

**Branch:** `feat/prompt-template-preview-panel`

**Baseline:** `main` at `a913890c`

## The problem

The prompt-template picker (`mode === 'prompt-template'` in
`CommandPalette.tsx`) shows each template as a title plus a **truncated**
one-line description:

```tsx
<div className="text-[10px] text-muted mt-0.5 truncate">
  {template.description}
</div>
```

That description is authored prose *about* the template, not the template. So
the picker never shows the one thing the user is actually choosing between:
**the prompt text that will land in the composer.** Today the only ways to read
a template body are to insert it and look at the composer, or to open the
manager and edit it. Both are worse than a glance.

This matters more now than it did when the picker was built. Custom templates
(PR #576) mean the list grows with prompts the user wrote themselves, possibly
weeks ago, whose titles stop being self-describing very quickly.

## The fix

Render a side panel next to the list, showing the highlighted template in full.
This is a shape the palette already has — twice:

- `CommandDescriptionPanel` (`CommandPalette.tsx:1751`) for `mode === 'commands'`
- the `SessionPreviewPane` aside (`:1728`) for `mode === 'resume'`

Adding a third is convergence, not a new pattern.

### Hover comes free — do not add hover state

The requirement is "show it when the user hovers." The rows already do this:

```tsx
onMouseEnter={() => setSelectedIndex(i)}
```

Hover and keyboard (↑/↓) both write the same `selectedIndex`. A panel that reads
`filteredPromptTemplates[selectedIndex]` therefore follows hover *and* arrow keys
with no new state, no `onMouseLeave`, and no divergence between "the highlighted
row" and "the previewed template". This is the same reasoning already written
down for `resumePreviewTarget` at `:1136` — worth repeating in code because the
obvious implementation (a local `hoveredTemplate` state) would introduce a
second source of truth that keyboard navigation silently fails to update.

## Decision: static bodies only

Three of the five built-in templates carry a literal `body`. **Two do not** —
`builtin:analyze-worktree-dump` (`templates.ts:209`) and
`builtin:active-tab-agent-transcripts` (`:223`) define an async
`buildBody(context)` that computes the real prompt from live workspace state
(worktree dumps, resolved transcript paths). Their static `body` is a one-line
stand-in: `'Please analyze this Agent Code worktree status dump.'`

So "the full prompt template" is genuinely ambiguous for those two. Three options
were considered:

1. **Static `body` only**, with a note on the dynamic ones. ← chosen
2. Resolve `buildBody` on hover, showing exactly what would be inserted.
3. Static by default, with a "preview with live context" button.

**We are doing (1).** Option 2 is the truthful one, and it is the wrong trade:
it turns every hover into async workspace I/O and transcript-path resolution,
inside the command palette — the surface where jank is least acceptable — and
drags in debouncing, a stale-response guard keyed to the hovered id, a loading
state, and an error state. That is a large amount of machinery, all of it in the
hot path, to improve two built-in rows. The value the user asked for — *see the
prompt instead of a truncated one-liner* — is fully delivered by the static body
for 3/5 built-ins and **100% of custom templates**, which are the ones that
accumulate and the ones whose titles go stale.

For the two dynamic templates we show the static body plus an explicit note that
the real prompt is generated at insert time and the text shown is a placeholder.
That is honest about the gap rather than quietly showing a stand-in as if it
were the whole prompt.

**Correction after review.** The first implementation worded that note as "live
workspace context is *added* to this prompt … the text below is the fixed part
only." Both review agents independently caught that this is wrong twice over:
`buildBody` **replaces** the body (`executePromptTemplate` picks one or the
other, never both), and nothing requires the generated prompt to contain the
static body — `builtin:active-tab-agent-transcripts` opens with a different
sentence entirely and then adds fixed transcript-reading guidance the
placeholder never mentions. `PromptTemplateManagerPane` had already reached the
right conclusion, calling the same field "a one-line placeholder" and
suppressing Duplicate for these templates. The panel now agrees with it. A panel
whose entire purpose is "show what you actually get" must not be the thing
making a confident false claim.

Option 3 remains open as a follow-up; nothing here blocks it. It is deliberately
not in this PR.

## Implementation

### New file: `features/prompt-templates/ui/PromptTemplatePreviewPanel.tsx`

Presentational, memoized, no store access — it takes a `PromptTemplate | null`
and renders it. Lives in the prompt-templates feature (not in the palette)
because it describes a template; the palette is just its first caller. Matches
the flat `features/<feature>/ui/Foo.tsx` convention used by
`PromptTemplateFillPane`, `PromptTemplateEditorPane`, and `SessionPreviewPane`.

Panel contents, top to bottom:

- **Header** — title, `builtin`/`custom` scope badge, and the insert mode stated
  as an effect ("Replaces composer text" / "Appends to composer text") rather
  than as the raw enum, which means nothing to a reader.
- **Description** — the authored one-liner, untruncated.
- **Dynamic-context note** — only when `template.buildBody` is defined.
- **Variables** — only when non-empty: `{{name}}`, label, required marker,
  default value.
- **Body** — verbatim, in a `<pre>`.

**The body renders as preformatted text, never as markdown.** The command
description panel uses `ReactMarkdown` because command descriptions are authored
markdown meant to be read as rich text. Template bodies are the opposite: they
are literal characters destined for the composer. Passing them through markdown
would swallow `**`, reflow `-` lists, turn `#` into headings, and collapse the
blank lines that several bodies use as structure — showing the user something
other than what they are about to insert, which defeats the entire feature.
`whitespace-pre-wrap` + `font-code` keeps it exact and wrappable.

### Modified: `features/command-palette/ui/CommandPalette.tsx`

1. Derive the selected template next to the existing `resumePreviewTarget`:

   ```tsx
   const selectedPromptTemplate = mode === 'prompt-template'
     ? (filteredPromptTemplates[selectedIndex] as PromptTemplate | undefined) ?? null
     : null
   ```

   The cast mirrors the one at `:1151` and exists for the same reason
   (`noUncheckedIndexedAccess`).

2. Render it as a sibling of the existing panels:

   ```tsx
   {mode === 'prompt-template' && (
     <PromptTemplatePreviewPanel template={selectedPromptTemplate} />
   )}
   ```

### Layout

Reuse the `CommandDescriptionPanel` geometry verbatim:
`hidden basis-[30%] min-w-[220px] overflow-y-auto bg-canvas px-4 py-4 md:block`.

`hidden … md:block` is a deliberate carry-over, not a copy-paste artifact: below
`md` the palette is list-only for both commands and resume, and the template
picker must not be the one mode that squeezes a two-column layout into a narrow
dialog. Same breakpoint policy, same reason.

The dialog already sizes itself for a side panel in commands mode, so no
`DialogContent` change is expected — to be confirmed during implementation.

## Out of scope

- The manager pane (`PromptTemplateManagerPane`). The request was the selection
  menu; the manager already exposes bodies through its editor.
- Resolving `buildBody` for preview (option 3 above).
- Syntax-highlighting `{{variable}}` placeholders inside the body. The variables
  section already names them; highlighting is decoration with a parser attached.

## Verification

- `tsc -p tsconfig.node.json` and `tsc -p tsconfig.web.json` — the real gate;
  neither `electron-vite build` nor vitest type-checks.
- `npm test` once at the end.
- Manual: open a session palette → *Prompt Template…* → hover and arrow through
  the list; confirm the panel tracks both, that bodies render with their line
  breaks and literal markdown characters intact, and that the two dynamic
  built-ins show the context note.

No new test files — this is presentational rendering of data that existing
template tests already cover.
