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

/**
 * Every `{{key:…}}` occurrence, well-formed or not.
 *
 * WHY the pattern deliberately accepts a malformed SPEC instead of refusing to
 * match it: the old pattern excluded `/` from both halves, so `{{key:Provider}}`
 * and `{{key:A/B/C}}` matched nothing at all — they were invisible to
 * collection, invisible to validation, and survived the final `body.replace`
 * untouched. A typo'd reference was therefore pasted into the prompt VERBATIM,
 * which is the exact silent-failure mode the header paragraph says this
 * grammar exists to avoid ("resolution aborts loudly").
 *
 * The `key:` prefix and the `[^{}]` body keep this from colliding with the
 * ordinary `{{variable}}` grammar, whose placeholder pattern is `[A-Za-z0-9_]+`
 * and cannot contain a colon.
 */
const KEY_REF_PATTERN = /\{\{\s*key:([^{}]*?)\s*\}\}/g

type ParsedReference =
  | { ok: true; ref: KeyReference }
  | { ok: false; spec: string }

/**
 * Exactly one separator, and both halves non-empty after trimming.
 *
 * A name containing `/` is therefore unaddressable. That is deliberate and is
 * the reason to reject rather than to guess: with two separators there is no
 * evidence for which one divides provider from key, and picking one would
 * resolve a reference the author did not write.
 */
function parseReference(spec: string): ParsedReference {
  const parts = spec.split('/')
  if (parts.length !== 2) return { ok: false, spec }
  const providerName = parts[0].trim()
  const keyName = parts[1].trim()
  if (!providerName || !keyName) return { ok: false, spec }
  return { ok: true, ref: { providerName, keyName } }
}

function referenceKey(ref: KeyReference): string {
  // NUL separator so a provider named "a" with key "b/c" cannot collide with
  // provider "a/b" key "c" — unreachable through parseReference today, but the
  // map is also written from the replace callback.
  return `${ref.providerName}\u0000${ref.keyName}`
}

/** Well-formed references, in first-appearance order, deduped. */
export function collectKeyReferences(body: string): KeyReference[] {
  const seen = new Set<string>()
  const ordered: KeyReference[] = []
  for (const parsed of parseAll(body)) {
    if (!parsed.ok) continue
    const dedupeKey = referenceKey(parsed.ref)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ordered.push(parsed.ref)
  }
  return ordered
}

function parseAll(body: string): ParsedReference[] {
  return [...body.matchAll(KEY_REF_PATTERN)].map(match => parseReference(match[1]))
}

export async function resolveKeyReferences(
  body: string,
  resolve: (ref: KeyReference) => Promise<string | null>,
): Promise<string> {
  // Resolve every distinct reference out of band first (a synchronous
  // String.replace callback cannot await, and each ref may cross the
  // vault gate), collecting ALL failures so one error message tells the
  // user everything that needs fixing.
  const values = new Map<string, string>()
  const failures: string[] = []
  const seen = new Set<string>()

  for (const parsed of parseAll(body)) {
    if (!parsed.ok) {
      const label = `{{key:${parsed.spec}}}`
      if (!failures.includes(label)) failures.push(label)
      continue
    }
    const dedupeKey = referenceKey(parsed.ref)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    // WHY the call is wrapped: the aggregation above was dead code in
    // production. The real adapter is `window.api.keyVaultResolveReference`,
    // typed `Promise<string>`, and VaultService throws on every failure mode —
    // unknown provider, unknown key, a cancelled unlock. `value === null` was
    // therefore unreachable, the first bad reference escaped this loop, and
    // "one error message tells the user everything that needs fixing" was
    // simply false. The service's own message is kept, because it is written
    // for direct display and distinguishes "no such key" from "vault locked".
    let value: string | null
    try {
      value = await resolve(parsed.ref)
    } catch (error) {
      const detail = error instanceof Error && error.message.length > 0 ? error.message : null
      failures.push(`{{key:${parsed.ref.providerName}/${parsed.ref.keyName}}}${detail ? ` (${detail})` : ''}`)
      continue
    }
    if (value === null || value.length === 0) {
      failures.push(`{{key:${parsed.ref.providerName}/${parsed.ref.keyName}}}`)
      continue
    }
    values.set(dedupeKey, value)
  }

  if (failures.length > 0) {
    throw new Error(`Unresolved key reference: ${failures.join(', ')}`)
  }
  // A function replacer, never a string: `$&` or `$1` inside a SECRET would
  // otherwise be interpreted as a substitution pattern.
  return body.replace(KEY_REF_PATTERN, (match, spec: string) => {
    const parsed = parseReference(spec)
    // Unreachable — a malformed spec threw above — but returning the original
    // text is the safe answer if that ever stops being true, since it cannot
    // insert a wrong secret.
    if (!parsed.ok) return match
    return values.get(referenceKey(parsed.ref)) ?? ''
  })
}
