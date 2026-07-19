import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import type {
  PromptTemplate,
  PromptTemplateInsertMode,
  PromptTemplateVariableValueMap,
} from '@renderer/features/prompt-templates/types'

type Props = {
  template: PromptTemplate
  values: PromptTemplateVariableValueMap
  insertMode: PromptTemplateInsertMode
  onValueChange: (name: string, value: string) => void
  onInsertModeChange: (mode: PromptTemplateInsertMode) => void
  onCancel: () => void
  onInsert: () => void
}

export function PromptTemplateFillPane({
  template,
  values,
  insertMode,
  onValueChange,
  onInsertModeChange,
  onCancel,
  onInsert,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[12px] text-ink">Use Template</div>
        <div className="mt-1 text-[11px] text-muted">{template.title}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {template.variables.map(variable => (
            <label key={variable.name} className="block text-[11px] text-muted">
              <div className="mb-1 flex items-center gap-2">
                <span>{variable.label}</span>
                {variable.required ? (
                  <span className="text-[9px] uppercase tracking-wider text-danger">required</span>
                ) : null}
              </div>
              <Input
                value={values[variable.name] ?? variable.defaultValue}
                onChange={event => onValueChange(variable.name, event.target.value)}
                placeholder={variable.description || variable.defaultValue}
              />
              {variable.description ? (
                <div className="mt-1 text-[10px] text-muted">{variable.description}</div>
              ) : null}
            </label>
          ))}

          <div className="pt-2 text-[11px] text-muted">Insert mode</div>
          <div className="flex items-center gap-4 text-[11px] text-ink">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={insertMode === 'replace'}
                onChange={() => onInsertModeChange('replace')}
              />
              Replace current draft
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={insertMode === 'append'}
                onChange={() => onInsertModeChange('append')}
              />
              Append to current draft
            </label>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={onInsert}>Insert Template</Button>
      </div>
    </div>
  )
}
