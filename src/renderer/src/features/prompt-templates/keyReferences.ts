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
 * Every `{{key:…/…}}` occurrence, well-formed or not.
 *
 * WHY it matches a malformed SPEC rather than refusing to match: the original
 * pattern excluded `/` from both halves, so `{{key:A/B/C}}` matched nothing at
 * all — invisible to collection, invisible to validation, and untouched by the
 * final `body.replace`. A typo'd reference was pasted into the prompt VERBATIM,
 * which is the silent-failure mode the header paragraph says this grammar
 * exists to avoid.
 *
 * WHY the separator is still REQUIRED, which is the part that took a second
 * pass to get right: a first attempt accepted any `{{key:…}}` at all so that
 * `{{key:Provider}}` could be reported as a missing separator. That
 * over-captured ordinary text. `<Widget options={{key: value}} />` is
 * everyday JSX, and it began aborting template insertion outright — a template
 * that had always worked now failed, with no way to escape it, not even inside
 * a code fence. Pasted logs and JSON carrying `{{key: …}}` regressed the same
 * way.
 *
 * A `/` is the thing that makes an occurrence look deliberately like a vault
 * reference rather than an object literal, so it is the boundary. The cost is
 * that a separator-less typo goes back to passing through untouched, exactly
 * as it did before this file existed. That is strictly better than breaking
 * text the user did not intend as syntax.
 *
 * The `key:` prefix and the `[^{}]` body also keep this from colliding with
 * the ordinary `{{variable}}` grammar, whose placeholder pattern is
 * `[A-Za-z0-9_]+` and cannot contain a colon.
 */
const KEY_REF_PATTERN = /\{\{\s*key:([^{}]*\/[^{}]*?)\s*\}\}/g

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
  // A spec reaches here only with at least one separator (the pattern requires
  // it), so this rejects two-or-more, never zero.
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
      value = await resolve(parsed.ref)
    } catch (error) {
      const detail = error instanceof Error && error.message.length > 0 ? error.message : null
      failures.push(`{{key:${parsed.ref.providerName}/${parsed.ref.keyName}}}${detail ? ` (${detail})` : ''}`)
      break
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
