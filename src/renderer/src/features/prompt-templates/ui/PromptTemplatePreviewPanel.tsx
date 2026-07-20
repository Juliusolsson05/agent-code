import { memo } from 'react'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

// WHY this panel exists:
//
// The prompt-template picker used to show a title plus a *truncated* one-line
// description. That description is prose authored ABOUT the template, so the
// picker never showed the one thing the user is choosing between: the prompt
// text that is about to land in their composer. Reading a body meant inserting
// it and looking at the composer, or opening the manager and editing it.
//
// WHY it lives in features/prompt-templates/ and not in the command palette:
// it describes a template, and knows nothing about palette modes, selection, or
// keyboard handling. The palette is merely its first caller. Keeping it here
// means a future surface (manager preview, a hover card elsewhere) can reuse it
// without importing from the palette.
//
// WHY it takes a template instead of reading the store: the caller already owns
// selection state. A panel that re-derived "which template is highlighted" would
// create a second source of truth that keyboard navigation could desync from —
// see the note on `selectedPromptTemplate` in CommandPalette.tsx.

// WHY the enum is not shown raw: `insertMode` is `'replace' | 'append'`, which
// describes the implementation, not the consequence. The user is deciding
// whether hitting Enter will destroy what they already typed — say that.
const INSERT_MODE_LABEL: Record<PromptTemplate['insertMode'], string> = {
  replace: 'Replaces composer text',
  append: 'Appends to composer text',
}

// Geometry is copied verbatim from CommandDescriptionPanel. The duplication is
// deliberate: these are two independent panels that happen to agree today, and
// extracting a shared shell would couple a markdown description panel to a
// preformatted body panel for the sake of one className.
//
// `hidden … md:block` is load-bearing, not a copy-paste artifact. Below `md`
// the palette is list-only in BOTH commands and resume mode; the template
// picker must not become the single mode that forces a two-column layout into
// a narrow dialog.
const PANEL_CLASS =
  'hidden basis-[30%] min-w-[220px] overflow-y-auto bg-canvas px-4 py-4 md:block'

export const PromptTemplatePreviewPanel = memo(function PromptTemplatePreviewPanel({
  template,
}: {
  template: PromptTemplate | null
}) {
  if (!template) {
    return (
      <aside
        role="region"
        aria-label="Prompt template preview"
        className={`${PANEL_CLASS} text-[12px] text-muted`}
      >
        Select a template to see the full prompt.
      </aside>
    )
  }

  return (
    <aside role="region" aria-label="Prompt template preview" className={PANEL_CLASS}>
      <div className="mb-3 border-b border-border pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] text-ink">{template.title}</div>
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
            {template.scope}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-muted">
          {INSERT_MODE_LABEL[template.insertMode]}
        </div>
      </div>

      {template.description && (
        <p className="mb-3 text-[11px] leading-[1.55] text-ink-dim">{template.description}</p>
      )}

      {/*
        WHY this note exists: `builtin:analyze-worktree-dump` and
        `builtin:active-tab-agent-transcripts` compute their real prompt through
        an async `buildBody(context)` from live workspace state. Their static
        `body` below is a one-line stand-in, NOT the full prompt.

        We deliberately do not resolve `buildBody` here. Doing so would turn
        every hover into async workspace I/O and transcript-path resolution
        inside the command palette, requiring debouncing, a stale-response guard
        keyed to the hovered template id, and loading/error states — a lot of
        machinery in a hot path to improve two built-in rows.

        Showing the stand-in silently would be the actual bug: the user would
        read one sentence and believe that is the whole prompt. So we say so.
      */}
      {template.buildBody && (
        <p className="mb-3 border border-border bg-surface px-2 py-1.5 text-[10px] leading-[1.5] text-muted">
          Live workspace context is generated and added to this prompt when you
          insert it. The text below is the fixed part only.
        </p>
      )}

      {template.variables.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">Variables</div>
          <div className="flex flex-col gap-1.5">
            {template.variables.map(variable => (
              <div key={variable.name} className="text-[10px] leading-[1.5]">
                <div className="flex items-center gap-1.5">
                  <span className="font-code text-ink-dim">{`{{${variable.name}}}`}</span>
                  {variable.required && (
                    <span className="uppercase tracking-wider text-muted">required</span>
                  )}
                </div>
                {variable.label && <div className="text-muted">{variable.label}</div>}
                {variable.defaultValue && (
                  <div className="text-muted">Default: {variable.defaultValue}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">Prompt</div>
        {/*
          WHY <pre> and NOT ReactMarkdown, even though the sibling command
          description panel uses markdown:
          command descriptions are authored markdown meant to be READ as rich
          text. Template bodies are the opposite — literal characters destined
          for the composer. Rendering them as markdown would swallow `**`,
          reflow `-` lists, promote `#` to headings, and collapse the blank
          lines several bodies use as structure, showing the user something
          other than what they are about to insert. That defeats the entire
          point of this panel. Keep it verbatim.
        */}
        <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-[1.55] text-ink-dim">
          {template.body}
        </pre>
      </div>
    </aside>
  )
})
