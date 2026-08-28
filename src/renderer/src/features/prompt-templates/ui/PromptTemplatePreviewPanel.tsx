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
        {/*
          `break-words` on every user-authored string in this panel, not just
          the body: the editor imposes no length limit on titles, descriptions,
          variable names, labels, or defaults, and this column is only ~220px
          at its floor. A pasted URL, UUID, or absolute path in any of them
          would otherwise paint over the scope badge or force the panel to
          scroll horizontally. The <pre> already handles this via break-words;
          these were the paths that did not.
        */}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 break-words text-[13px] text-ink">{template.title}</div>
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
            {template.scope}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-muted">
          {INSERT_MODE_LABEL[template.insertMode]}
        </div>
      </div>

      {template.description && (
        <p className="mb-3 break-words text-[11px] leading-[1.55] text-ink-dim">
          {template.description}
        </p>
      )}

      {/*
        WHY this note exists: `builtin:analyze-worktree-dump` and
        `builtin:active-tab-agent-transcripts` compute their real prompt through
        an async `buildBody(context)`. Their static `body` below is a one-line
        placeholder, NOT the full prompt.

        WHY the wording is "placeholder" and not "the fixed part": `buildBody`
        REPLACES the body outright — `executePromptTemplate` does
        `template.buildBody ? await template.buildBody(...) : template.body`.
        It does not append to it, and nothing requires the generated prompt to
        contain the static body at all. `builtin:active-tab-agent-transcripts`
        already proves the point: its generated prompt opens with a *different*
        sentence than its static body and then adds ~15 lines of fixed "how to
        read a JSONL transcript" guidance the placeholder never mentions. An
        earlier draft of this note claimed the text below was "the fixed part
        only", which was wrong twice over and is exactly the kind of confident
        half-truth this panel exists to eliminate.

        `PromptTemplateManagerPane` reached the same conclusion independently —
        it calls this field "a one-line placeholder" and suppresses Duplicate
        for these templates so the copy cannot "quietly underdeliver". Keep the
        two descriptions in agreement.

        We deliberately do not resolve `buildBody` here. Doing so would turn
        every hover into async workspace I/O and transcript-path resolution
        inside the command palette, requiring debouncing, a stale-response guard
        keyed to the hovered template id, and loading/error states — a lot of
        machinery in a hot path to improve two built-in rows.
      */}
      {template.buildBody && (
        <p className="rounded-slab mb-3 border border-border bg-surface px-2 py-1.5 text-[10px] leading-[1.5] text-muted">
          This prompt is generated from live workspace state when you insert it.
          The text below is a placeholder — not the prompt you will get.
        </p>
      )}

      {template.variables.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">Variables</div>
          <div className="flex flex-col gap-1.5">
            {template.variables.map(variable => (
              <div key={variable.name} className="text-[10px] leading-[1.5]">
                <div className="flex items-start gap-1.5">
                  <span className="min-w-0 break-words font-code text-ink-dim">
                    {`{{${variable.name}}}`}
                  </span>
                  {variable.required && (
                    <span className="flex-shrink-0 uppercase tracking-wider text-muted">
                      required
                    </span>
                  )}
                </div>
                {variable.label && <div className="break-words text-muted">{variable.label}</div>}
                {variable.defaultValue && (
                  <div className="break-words text-muted">Default: {variable.defaultValue}</div>
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
