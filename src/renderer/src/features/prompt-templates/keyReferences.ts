// API Key Vault references inside prompt template bodies (#831).
//
// Syntax: {{key:Provider Name/Key Name}} — matched case-sensitively
// against vault metadata at execution time. WHY names and not ids:
// templates are user-authored text that must stay readable and
// portable; uuids would make every template an opaque pile. Renaming a
// provider or key therefore breaks its references — resolution aborts
// loudly with a toast instead of silently inserting nothing.
//
// WHY this pattern is separate from the ordinary {{variable}} grammar:
// the placeholder pattern is [A-Za-z0-9_]+ only, so these refs never
// collide with or surface as form fields in the fill pane; they are
// resolved only after variable fill, at insertion, so the pane never sees a secret.

import { fillPromptTemplateBody } from './interpolate'
import type { PromptTemplate, PromptTemplateVariableValueMap } from './types'

// Both picker paths share this order. Resolving before the fill pane either
// exposed credentials in its preview or discarded the resolved body entirely.
export function prepareTemplateText(
  template: Pick<PromptTemplate, 'body' | 'variables'>,
  values: PromptTemplateVariableValueMap,
  resolve: (ref: KeyReference) => Promise<string | null>,
): Promise<string> {
  // Dynamic worktree/transcript dumps can contain Vue/Jinja/Handlebars braces.
  // With no declared variables the old picker inserted that source verbatim;
  // running the filler would silently erase every unrelated {{word}}.
  const body = template.variables.length ? fillPromptTemplateBody({ ...template, values }) : template.body
  return resolveKeyReferences(body, resolve)
}

export type KeyReference = { providerName: string; keyName: string }

const KEY_REF_PATTERN = /\{\{\s*key:([^/{}]+?)\/([^/{}]+?)\s*\}\}/g

export function collectKeyReferences(body: string): KeyReference[] {
  const seen = new Set<string>()
  const ordered: KeyReference[] = []
  for (const match of body.matchAll(KEY_REF_PATTERN)) {
    const ref = { providerName: match[1].trim(), keyName: match[2].trim() }
    const dedupeKey = `${ref.providerName}\u0000${ref.keyName}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ordered.push(ref)
  }
  return ordered
}

export async function resolveKeyReferences(
  body: string,
  resolve: (ref: KeyReference) => Promise<string | null>,
): Promise<string> {
  // Resolve every distinct reference out of band first (a synchronous
  // String.replace callback cannot await, and each ref may cross the
  // vault gate), collecting ALL failures so one error message tells the
  // user everything that needs fixing.
  const refs = collectKeyReferences(body)
  const values = new Map<string, string>()
  const failures: string[] = []
  for (const ref of refs) {
    const value = await resolve(ref)
    if (value === null || value.length === 0) {
      failures.push(`{{key:${ref.providerName}/${ref.keyName}}}`)
      continue
    }
    values.set(`${ref.providerName}\u0000${ref.keyName}`, value)
  }
  if (failures.length > 0) {
    throw new Error(`Unresolved key reference: ${failures.join(', ')}`)
  }
  return body.replace(KEY_REF_PATTERN, (_match, rawProvider: string, rawKey: string) => {
    return values.get(`${rawProvider.trim()}\u0000${rawKey.trim()}`) ?? ''
  })
}
