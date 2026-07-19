import type { ReactNode } from 'react'

import { Button } from '@renderer/components/ui/button'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

type Props = {
  templates: PromptTemplate[]
  onUse: (template: PromptTemplate) => void
  onCreate: () => void
  onEdit: (template: PromptTemplate) => void
  onDuplicate: (template: PromptTemplate) => void
  onDelete: (template: PromptTemplate) => void
}

export function PromptTemplateManagerPane({
  templates,
  onUse,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
}: Props) {
  const builtins = templates.filter(template => template.scope === 'builtin')
  const customs = templates.filter(template => template.scope === 'custom')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <div className="text-[12px] text-ink">Prompt Templates</div>
          <div className="mt-1 text-[11px] text-muted">
            Use built-ins as-is, or create custom templates with variables and insert-mode defaults.
          </div>
        </div>
        <Button type="button" size="sm" onClick={onCreate}>+ New</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Built-in" empty="No built-in templates matched.">
          {builtins.map(template => (
            <TemplateRow
              key={template.id}
              template={template}
              onUse={() => onUse(template)}
              actions={
                <Button type="button" variant="outline" size="xs" onClick={() => onDuplicate(template)}>
                  Duplicate
                </Button>
              }
            />
          ))}
        </Section>

        <Section title="Custom" empty="No custom templates yet.">
          {customs.map(template => (
            <TemplateRow
              key={template.id}
              template={template}
              onUse={() => onUse(template)}
              actions={
                <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" size="xs" onClick={() => onEdit(template)}>
                    Edit
                  </Button>
                  <Button type="button" variant="outline" size="xs" onClick={() => onDuplicate(template)}>
                    Dup
                  </Button>
                  <Button type="button" variant="destructive" size="xs" onClick={() => onDelete(template)}>
                    Delete
                  </Button>
                </div>
              }
            />
          ))}
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: ReactNode
}) {
  const count = Array.isArray(children) ? children.length : (children ? 1 : 0)
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div>
        {count === 0 ? (
          <div className="px-3 pb-3 text-[11px] text-muted">{empty}</div>
        ) : children}
      </div>
    </section>
  )
}

function TemplateRow({
  template,
  onUse,
  actions,
}: {
  template: PromptTemplate
  onUse: () => void
  actions: ReactNode
}) {
  return (
    <div className="border-t border-border px-3 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onUse}>
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] text-ink">{template.title}</span>
            <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
              {template.scope}
            </span>
            <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
              {template.insertMode}
            </span>
            <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
              vars:{template.variables.length}
            </span>
          </div>
          <div className="mt-1 truncate text-[10px] text-muted">{template.description}</div>
        </button>
        <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>
      </div>
    </div>
  )
}
