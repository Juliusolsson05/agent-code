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
  /**
   * Where the filled template will actually land, per `textDeliverySurface`
   * (#865). A PTY target has no draft to replace or append to — the text is
   * pasted at the terminal cursor — so offering the replace/append radios
   * there described a choice that does not exist and, worse, claimed
   * "replace" would replace something when it only pastes.
   */
  deliverySurface: 'composer' | 'pty'
  onValueChange: (name: string, value: string) => void
  onInsertModeChange: (mode: PromptTemplateInsertMode) => void
  onCancel: () => void
  onInsert: () => void
}

export function PromptTemplateFillPane({
  template,
  values,
  insertMode,
  deliverySurface,
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

          {deliverySurface === 'composer' ? (
            <>
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
            </>
          ) : (
            <div className="pt-2 text-[11px] text-muted">
              Pastes at the terminal cursor. Nothing is replaced, and nothing runs until you press Enter.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={onInsert}>Insert Template</Button>
      </div>
    </div>
  )
}
