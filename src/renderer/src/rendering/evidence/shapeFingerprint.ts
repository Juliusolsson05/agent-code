import type { AgentProviderKind } from '@shared/types/providerKind'
import { SENSITIVE_KEY } from '@renderer/rendering/model/sensitiveKey'

// ---------------------------------------------------------------------------
// Structural fingerprint — the canonical shape identity (Phase 1 of the
// evidence-first rendering plan, PR #554).
//
// Answers exactly one question: "have we seen this STRUCTURE before?" —
// where structure means provider + plane + event/tool discriminator + the
// key/type skeleton of the payload, and NEVER its content. `Bash ls` and
// `Bash git status` are one shape; `Bash` and `Edit` are two, because the
// tool name is a render-relevant discriminator that selects the visual
// grammar.
//
// WHY a second identity next to hashPayload (unknowns.ts): the payload hash
// is content-sensitive, so every distinct command/prompt looks like a new
// shape — useless as a catalog key, still useful as a bounded dedup/sample
// identity. The two identities deliberately coexist: catalog groups by
// fingerprint, sightings count distinct payload hashes within a group.
//
// STABILITY CONTRACT: once provider catalogs pin fingerprints (Phase 4+),
// changing ANY behavior in this file silently orphans every pinned entry.
// The test file is the frozen executable spec; treat green-to-green
// "refactors" of the canonical serialization as breaking changes. If the
// algorithm must evolve, version it (fp1: prefix) and re-pin catalogs in the
// same PR — do not mutate fp1 semantics in place.
//
// PRIVACY: the recipe never serializes leaf values. The only payload-derived
// strings that can appear in the output are (a) sorted KEY names, (b) leaf
// TYPE names, and (c) allowlisted discriminator values that pass a strict
// token regex (so a prompt or path can never ride along in `name`). Secret-
// keyed subtrees are dropped with the key name retained — the exact
// `<redacted-key>` convention of unknowns.ts/redact.ts, and enforced by the
// same SENSITIVE_KEY regex so the redaction surfaces cannot drift.
// ---------------------------------------------------------------------------

/**
 * Depth cap. 6 (vs shapePathsOf's 3) because real provider wire shapes nest
 * meaningfully deeper than the unknown registry's diagnostic preview needs —
 * e.g. entry.message.content[].input.todos[].status is depth 6 — and a cap
 * that clips a render-relevant discriminator would merge shapes the painter
 * must distinguish. Beyond the cap we emit a `<deep>` marker so two payloads
 * differing only below the cap intentionally merge.
 */
export const MAX_SHAPE_DEPTH = 6

/**
 * Hard bound on emitted paths. A pathological 100k-key object must cost
 * bounded work and bounded memory (this helper runs on the paint path in
 * capture mode — the renderer-freeze incident is why every collector in this
 * system is capped by construction). Truncation is explicit: the final path
 * is `<truncated-paths>` so a clipped shape can never silently collide with
 * an unclipped one that happens to share the surviving prefix.
 */
export const MAX_SHAPE_PATHS = 512

/**
 * Discriminator allowlist. `type`/`kind`/`subtype` are structural at ANY
 * depth (content blocks carry `content[].type=text|image|tool_use` — the
 * exact split the painter cares about). `name`/`toolName` are top-level
 * ONLY: at the top of a tool_use block `name` is the tool name and at the
 * top of a SEMANTIC live block the same fact travels as `toolName`
 * (session-runtime vocabulary) — both render-relevant, low cardinality.
 * Nested, `name` is routinely user data (MCP tool inputs, file names) and
 * would explode one shape into thousands.
 */
const DISCRIMINATOR_KEYS_ANY_DEPTH = new Set(['type', 'kind', 'subtype'])
const DISCRIMINATOR_KEYS_TOP_LEVEL = new Set(['name', 'toolName'])

/**
 * A discriminator VALUE must look like an enum token, not prose. Length ≤64
 * and no whitespace/slashes keeps prompts, sentences, and paths out even
 * when they arrive under an allowlisted key. Rejection means "excluded from
 * identity", never "recorded anyway" — failing open here would leak content
 * into checked-in catalogs.
 */
const DISCRIMINATOR_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/

export type ShapeFingerprintInput = {
  provider: AgentProviderKind | 'unknown'
  /**
   * Observation-plane label, part of the identity. Deliberately `string`,
   * not `RenderShapePlane`: two vocabularies legitimately flow through here
   * — the observer's RenderShapePlane (Phase 2) and the ledger's
   * RenderSourcePlane (the unknown registry). The helper canonicalizes
   * whatever plane vocabulary the observation site uses; constraining the
   * union is the caller's layer's job, and pinning one enum here would
   * force a lossy translation at the other call site.
   */
  plane: string
  /** Event/tool discriminator from the observation site (e.g. 'tool_use',
   *  a semantic event type, a condition kind). Part of the identity. */
  eventType: string
  payload: unknown
}

export type ShapeFingerprint = {
  /** `fp1-<8 hex>` — versioned so a future algorithm change is visible in
   *  every pinned catalog entry instead of silently re-keying them. */
  fingerprint: string
  /** Human-readable typed key paths (content-free) — what the fingerprint
   *  denotes, carried so inbox readers never re-derive it from payloads. */
  shapePaths: readonly string[]
  /** Allowlisted low-cardinality structural values, keyed by path. */
  discriminatorValues: Readonly<Record<string, string>>
}

/** Leaf type tag. Distinguishes the JSON-ish types the painter branches on;
 *  everything unserializable collapses to its typeof so hostile inputs are
 *  identity-stable without ever being stringified. */
function leafType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // string|number|boolean|undefined|object|function|symbol|bigint
}

/**
 * Walk the payload, collecting sorted typed key paths and discriminators.
 *
 * Arrays: all elements merge into ONE element shape under the `[]` segment
 * (sorted-set union of their paths). Length and element order must not
 * matter — a 1-todo and a 40-todo TodoWrite are the same shape, and provider
 * batches reorder freely. The union (rather than "first element wins") is
 * what keeps `[ {type:'text'}, {type:'text',citations:[]} ]` stable under
 * reordering: both variants contribute their paths regardless of position.
 *
 * Cycles: tracked via an ancestor set (not a global visited set — the same
 * object legitimately appearing under two siblings is a DAG, not a cycle,
 * and must contribute its shape both times).
 */
function collectPaths(
  value: unknown,
  prefix: string,
  depth: number,
  topLevel: boolean,
  ancestors: Set<object>,
  paths: Set<string>,
  discriminators: Map<string, string>,
): void {
  const t = leafType(value)

  if (t !== 'object' && t !== 'array') {
    paths.add(prefix ? `${prefix}:${t}` : `<root>:${t}`)
    return
  }

  const obj = value as object
  if (ancestors.has(obj)) {
    paths.add(`${prefix || '<root>'}:<cycle>`)
    return
  }
  if (depth >= MAX_SHAPE_DEPTH) {
    paths.add(`${prefix || '<root>'}:<deep>`)
    return
  }

  ancestors.add(obj)
  try {
    if (t === 'array') {
      const arr = value as unknown[]
      paths.add(prefix ? `${prefix}:array` : '<root>:array')
      // Every element merges into the single `[]` segment — see WHY above.
      for (const element of arr) {
        // JSON-PARITY: JSON.stringify turns an undefined ELEMENT into null,
        // and our evidence corpus (bundles, recordings, fixtures) is JSON on
        // disk while runtime payloads arrive via structured clone which
        // preserves undefined. Normalizing here keeps one shape from
        // fingerprinting differently live vs from its own serialized
        // evidence — the skew would file every affected live sighting as a
        // false unknown.
        collectPaths(
          element === undefined ? null : element,
          `${prefix}[]`,
          depth + 1,
          false,
          ancestors,
          paths,
          discriminators,
        )
      }
      return
    }

    paths.add(prefix ? `${prefix}:object` : '<root>:object')
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      const path = prefix ? `${prefix}.${key}` : key
      if (SENSITIVE_KEY.test(key)) {
        // Key NAME retained, VALUE/subtree never walked — the value's own
        // structure must not influence identity (a string token and an
        // object credential under `authorization` are the same shape).
        paths.add(`${path}=<redacted-key>`)
        continue
      }
      const child = (obj as Record<string, unknown>)[key]
      // JSON-PARITY (see the array comment above): JSON.stringify DROPS a
      // key whose value is undefined, so serialized evidence never shows
      // it while a structured-cloned runtime payload does. Skip it so the
      // same logical shape gets the same fingerprint from both sources.
      if (child === undefined) continue
      const eligible =
        DISCRIMINATOR_KEYS_ANY_DEPTH.has(key) ||
        (topLevel && DISCRIMINATOR_KEYS_TOP_LEVEL.has(key))
      if (eligible && typeof child === 'string' && DISCRIMINATOR_TOKEN.test(child)) {
        discriminators.set(path, child)
      }
      collectPaths(child, path, depth + 1, false, ancestors, paths, discriminators)
    }
  } finally {
    ancestors.delete(obj)
  }
}

/** Same dependency-free FNV-1a as unknowns.hashPayload — collisions merely
 *  merge two catalog groups, and determinism across environments (node unit
 *  runner, happy-dom, packaged renderer) is the property that matters. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function fingerprintRenderShape(input: ShapeFingerprintInput): ShapeFingerprint {
  const pathSet = new Set<string>()
  const discriminators = new Map<string, string>()
  collectPaths(input.payload, '', 0, true, new Set(), pathSet, discriminators)

  // Canonical order AFTER collection: identity must not depend on insertion
  // order (arrays merge element paths in element order; objects are sorted
  // per level but interleave with their children). One global sort makes the
  // serialization insensitive to walk order by construction.
  let shapePaths = [...pathSet].sort()
  if (shapePaths.length > MAX_SHAPE_PATHS) {
    shapePaths = shapePaths.slice(0, MAX_SHAPE_PATHS)
    shapePaths.push('<truncated-paths>')
  }

  const discriminatorValues: Record<string, string> = {}
  for (const key of [...discriminators.keys()].sort()) {
    discriminatorValues[key] = discriminators.get(key)!
  }

  // Control-char separators (escaped, never literal bytes in this file):
  // \u0000 cannot appear in JSON-parsed key names or token-validated
  // discriminator values, and \u0001 joins the five sections, so the
  // serialization is unambiguous (no "ab"+"c" == "a"+"bc" gluing).
  const canonical = [
    input.provider,
    input.plane,
    input.eventType,
    shapePaths.join('\u0000'),
    Object.entries(discriminatorValues)
      .map(([k, v]) => `${k}=${v}`)
      .join('\u0000'),
  ].join('\u0001')

  return {
    fingerprint: `fp1-${fnv1a(canonical)}`,
    shapePaths,
    discriminatorValues,
  }
}
