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
 * A well-formed vault reference: exactly one separator, neither half
 * containing another.
 *
 * WHY this pattern is NARROW, after an attempt to widen it was reverted:
 *
 * The narrowness has a real cost — a typo like `{{key:Brave}}` or
 * `{{key:A/B/C}}` matches nothing and is pasted into the prompt verbatim,
 * which is the silent failure the header paragraph above says this grammar
 * exists to avoid. Widening it to catch those looked obviously right and was
 * wrong: `{{key:…}}` with arbitrary contents is ordinary text.
 * `<Widget options={{key: value}} />` is everyday JSX. So is
 * `<Widget options={{key: "/api/v1"}} />` and `{{key: /abc/}}`, which a
 * separator requirement does not exclude either — a slash does not establish
 * that the author meant a vault reference. Templates that had always worked
 * began aborting insertion outright, with no way to escape the syntax, not
 * even inside a code fence.
 *
 * Breaking text nobody intended as syntax is worse than failing to diagnose a
 * typo. Catching typos properly needs an escape mechanism this grammar does
 * not have, so it is not attempted here.
 */
const KEY_REF_PATTERN = /\{\{\s*key:([^/{}]+?)\/([^/{}]+?)\s*\}\}/g

function referenceKey(ref: KeyReference): string {
  // NUL separator so two different (provider, key) pairs cannot produce the
  // same map key. Unreachable through this pattern, which forbids a slash in
  // either half, but the map is also written from the replace callback.
  return `${ref.providerName}\u0000${ref.keyName}`
}

function parseAll(body: string): KeyReference[] {
  return [...body.matchAll(KEY_REF_PATTERN)].map(match => ({
    providerName: match[1].trim(),
    keyName: match[2].trim(),
  }))
}

/** Well-formed references, in first-appearance order, deduped. */
export function collectKeyReferences(body: string): KeyReference[] {
  const seen = new Set<string>()
  const ordered: KeyReference[] = []
  for (const ref of parseAll(body)) {
    const dedupeKey = referenceKey(ref)
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
  const values = new Map<string, string>()
  const failures: string[] = []
  const seen = new Set<string>()

  for (const ref of parseAll(body)) {
    const dedupeKey = referenceKey(ref)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    // WHY the call is wrapped AND why the loop stops on the first throw:
    //
    // Wrapped, because the aggregation this function is built around was dead
    // code in production. The real adapter is
    // `window.api.keyVaultResolveReference`, typed `Promise<string>`, and
    // VaultService throws on every failure mode, so `value === null` was
    // unreachable and the first bad reference escaped the loop entirely.
    //
    // Stopping, because continuing is worse than the bug it fixed. One of
    // those failure modes is a CANCELLED unlock, and `ensureUnlocked` clears
    // its pending promise on cancellation — so carrying on to the next
    // reference opens another OS authentication prompt. A template with three
    // references asked once before, and would ask three times if this
    // continued. A user who just cancelled must not be re-asked.
    //
    // Whatever was collected before the failure is still reported alongside
    // it, and the service's own message is kept because it is written for
    // direct display and distinguishes "no such key" from "vault is locked".
    let value: string | null
    try {
      value = await resolve(ref)
    } catch (error) {
      const detail = error instanceof Error && error.message.length > 0 ? error.message : null
      failures.push(`{{key:${ref.providerName}/${ref.keyName}}}${detail ? ` (${detail})` : ''}`)
      break
    }
    if (value === null || value.length === 0) {
      failures.push(`{{key:${ref.providerName}/${ref.keyName}}}`)
      continue
    }
    values.set(dedupeKey, value)
  }

  if (failures.length > 0) {
    throw new Error(`Unresolved key reference: ${failures.join(', ')}`)
  }
  // A function replacer, never a string: `$&` or `$1` inside a SECRET would
  // otherwise be interpreted as a substitution pattern.
  return body.replace(KEY_REF_PATTERN, (_match, rawProvider: string, rawKey: string) =>
    values.get(referenceKey({ providerName: rawProvider.trim(), keyName: rawKey.trim() })) ?? '')
}
