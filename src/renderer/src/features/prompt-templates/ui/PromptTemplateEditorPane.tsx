import type { ReactNode } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import type {
  PromptTemplateInsertMode,
  PromptTemplateVariable,
} from '@renderer/features/prompt-templates/types'

export type PromptTemplateEditorForm = {
  id: string | null
  title: string
  description: string
  body: string
  insertMode: PromptTemplateInsertMode
  variables: PromptTemplateVariable[]
}

type Props = {
  form: PromptTemplateEditorForm
  onChange: (next: PromptTemplateEditorForm) => void
  onCancel: () => void
  onSave: () => void
}

export function PromptTemplateEditorPane({ form, onChange, onCancel, onSave }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[12px] text-ink">{form.id ? 'Edit Prompt Template' : 'New Prompt Template'}</div>
        <div className="mt-1 text-[11px] text-muted">
          Placeholders are detected from the body. Edit their labels/defaults below.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          <Field label="Title">
            <Input
              value={form.title}
              onChange={event => onChange({ ...form, title: event.target.value })}
              placeholder="Bug Repro Template"
            />
          </Field>

          <Field label="Description">
            <Input
              value={form.description}
              onChange={event => onChange({ ...form, description: event.target.value })}
              placeholder="Reusable debugging prompt"
            />
          </Field>

          <Field label="Insert mode">
            <div className="flex items-center gap-4 text-[11px] text-ink">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.insertMode === 'replace'}
                  onChange={() => onChange({ ...form, insertMode: 'replace' })}
                />
                Replace current draft
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.insertMode === 'append'}
                  onChange={() => onChange({ ...form, insertMode: 'append' })}
                />
                Append to current draft
              </label>
            </div>
          </Field>

          <Field label="Body">
            <Textarea
              className="min-h-56 resize-y"
              value={form.body}
              onChange={event => onChange({ ...form, body: event.target.value })}
              placeholder="Goal: {{goal}}"
            />
          </Field>

          <div>
            <div className="mb-2 text-[11px] text-muted">
              Variables in body: {form.variables.length === 0 ? 'none' : form.variables.map(variable => variable.name).join(', ')}
            </div>
            <div className="space-y-2">
              {form.variables.map((variable, index) => (
                <div key={variable.name} className="border border-border bg-surface px-3 py-3">
                  <div className="mb-2 text-[11px] text-ink">{`{{${variable.name}}}`}</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <Field label="Label">
                      <Input
                        value={variable.label}
                        onChange={event => onChange({
                          ...form,
                          variables: replaceVariable(form.variables, index, {
                            ...variable,
                            label: event.target.value,
                          }),
                        })}
                      />
                    </Field>
                    <Field label="Default value">
                      <Input
                        value={variable.defaultValue}
                        onChange={event => onChange({
                          ...form,
                          variables: replaceVariable(form.variables, index, {
                            ...variable,
                            defaultValue: event.target.value,
                          }),
                        })}
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <Input
                      value={variable.description}
                      onChange={event => onChange({
                        ...form,
                        variables: replaceVariable(form.variables, index, {
                          ...variable,
                          description: event.target.value,
                        }),
                      })}
                      placeholder="What the user should type here"
                    />
                  </Field>
                  <label className="mt-2 flex items-center gap-2 text-[11px] text-ink">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={event => onChange({
                        ...form,
                        variables: replaceVariable(form.variables, index, {
                          ...variable,
                          required: event.target.checked,
                        }),
                      })}
                    />
                    Require this value before insertion
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!form.title.trim() || !form.body.trim()}
        >
          Save Template
        </Button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[11px] text-muted">
      <div className="mb-1">{label}</div>
      {children}
    </label>
  )
}

function replaceVariable(
  variables: PromptTemplateVariable[],
  index: number,
  next: PromptTemplateVariable,
): PromptTemplateVariable[] {
  return variables.map((variable, currentIndex) => (currentIndex === index ? next : variable))
}
