import { collectPromptTemplatePlaceholders } from '@renderer/features/prompt-templates/interpolate'
import type {
  PromptTemplate,
  PromptTemplateInsertMode,
  PromptTemplateVariable,
  SavedPromptTemplateInput,
} from '@renderer/features/prompt-templates/types'

const CUSTOM_PROMPT_TEMPLATE_PREFIX = 'custom:'

function isInsertMode(value: unknown): value is PromptTemplateInsertMode {
  return value === 'replace' || value === 'append'
}

function defaultVariable(name: string): PromptTemplateVariable {
  return {
    name,
    label: name
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description: '',
    defaultValue: '',
    required: false,
  }
}

function coerceVariable(value: unknown): PromptTemplateVariable | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  return {
    name: record.name,
    label: typeof record.label === 'string' && record.label.length > 0
      ? record.label
      : defaultVariable(record.name).label,
    description: typeof record.description === 'string' ? record.description : '',
    defaultValue: typeof record.defaultValue === 'string' ? record.defaultValue : '',
    required: record.required === true,
  }
}

export function syncTemplateVariablesFromBody(
  body: string,
  variables: PromptTemplateVariable[],
): PromptTemplateVariable[] {
  const existing = new Map(variables.map(variable => [variable.name, variable]))
  return collectPromptTemplatePlaceholders(body).map(name => existing.get(name) ?? defaultVariable(name))
}

export function coerceSavedPromptTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || seen.has(record.id)) return []
    if (typeof record.title !== 'string' || typeof record.body !== 'string') return []
    seen.add(record.id)
    const variables = Array.isArray(record.variables)
      ? record.variables.flatMap(entry => {
        const coerced = coerceVariable(entry)
        return coerced ? [coerced] : []
      })
      : []
    return [{
      id: record.id,
      title: record.title.trim(),
      description: typeof record.description === 'string' ? record.description : 'Saved locally',
      body: record.body,
      scope: 'custom' as const,
      insertMode: isInsertMode(record.insertMode) ? record.insertMode : 'replace',
      variables: syncTemplateVariablesFromBody(record.body, variables),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    }]
  }).sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
}

export function createSavedPromptTemplate(input: SavedPromptTemplateInput): PromptTemplate {
  const now = Date.now()
  const body = input.body
  return {
    id: `${CUSTOM_PROMPT_TEMPLATE_PREFIX}${crypto.randomUUID()}`,
    title: input.title.trim(),
    description: input.description.trim() || 'Saved locally',
    body,
    scope: 'custom',
    insertMode: input.insertMode,
    variables: syncTemplateVariablesFromBody(body, input.variables),
    createdAt: now,
    updatedAt: now,
  }
}

export function updateSavedPromptTemplate(
  template: PromptTemplate,
  input: SavedPromptTemplateInput,
): PromptTemplate {
  const body = input.body
  return {
    ...template,
    title: input.title.trim(),
    description: input.description.trim() || 'Saved locally',
    body,
    insertMode: input.insertMode,
    variables: syncTemplateVariablesFromBody(body, input.variables),
    updatedAt: Date.now(),
  }
}

export function duplicatePromptTemplate(template: PromptTemplate): PromptTemplate {
  return createSavedPromptTemplate({
    title: `${template.title} (copy)`,
    description: template.description,
    body: template.body,
    insertMode: template.insertMode,
    variables: template.variables,
  })
}

export function findSavedPromptTemplate(
  templates: PromptTemplate[],
  id: string,
): PromptTemplate | null {
  return templates.find(template => template.id === id) ?? null
}
