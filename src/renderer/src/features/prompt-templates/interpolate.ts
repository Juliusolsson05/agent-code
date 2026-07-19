import type {
  PromptTemplateInsertMode,
  PromptTemplateVariable,
  PromptTemplateVariableValueMap,
} from '@renderer/features/prompt-templates/types'

const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g

export function collectPromptTemplatePlaceholders(body: string): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }
  return ordered
}

export function fillPromptTemplateBody({
  body,
  variables,
  values,
}: {
  body: string
  variables: PromptTemplateVariable[]
  values: PromptTemplateVariableValueMap
}): string {
  const variableMap = new Map(variables.map(variable => [variable.name, variable]))
  const missing = new Set<string>()
  const rendered = body.replace(PLACEHOLDER_PATTERN, (_match: string, rawName: string) => {
    const variable = variableMap.get(rawName)
    const explicit = values[rawName] ?? ''
    const resolved = explicit.length > 0
      ? explicit
      : (variable?.defaultValue ?? '')
    if (resolved.length === 0 && variable?.required) missing.add(rawName)
    return resolved
  })
  if (missing.size > 0) {
    throw new Error(`Missing required template values: ${[...missing].join(', ')}`)
  }
  return rendered
}

export function applyPromptTemplateInsertMode(
  currentDraft: string,
  insertedBody: string,
  mode: PromptTemplateInsertMode,
): string {
  if (mode === 'replace') return insertedBody
  if (!currentDraft) return insertedBody
  if (!insertedBody) return currentDraft
  return `${currentDraft}\n\n${insertedBody}`
}
