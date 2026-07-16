import type { AgentProviderKind } from '@shared/types/providerKind'
import { SENSITIVE_KEY } from '@renderer/rendering/model/sensitiveKey'

// ---------------------------------------------------------------------------
// Structural fingerprint — the canonical shape identity (Phase 1 of the
// evidence-first rendering plan, PR #554/#555).
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
// same PR — do not mutate fp1 semantics in place. (This happened once
// already, pre-merge: the 2026-07-16 review panel forced dynamic-key
// normalization + order-free discriminators, and the catalogs were re-seeded
// in the same commit.)
//
// PRIVACY: the recipe never serializes leaf values, and — after the review
// panel's A1 finding — never serializes UNVETTED KEY NAMES either. Object
// keys are structural only when they look like identifiers; anything else
// (paths, URLs, filenames, prompts used as map keys) collapses to `<dyn>`,
// which simultaneously closes the key-name leak route AND stops dynamic-key
// maps from minting one fingerprint per filename. Secret-keyed subtrees are
// dropped with the key name retained — the exact `<redacted-key>` convention
// of unknowns.ts/redact.ts, enforced by the same SENSITIVE_KEY regex so the
// redaction surfaces cannot drift.
//
// JSON-PARITY: the evidence corpus is JSON on disk while runtime payloads
// arrive via structured clone. JSON.stringify drops undefined-valued keys
// and turns undefined array elements into null — both normalized here so
// one logical shape fingerprints identically from either source. Known
// residual divergences, accepted because realistic payloads are JSON-derived
// end to end: NaN/Infinity (number live, null from disk) and Date/Map/Set
// class instances (object live, string/{}/{} from disk). If a real payload
// ever hits one of these, it files as a shape variant, not a crash.
// ---------------------------------------------------------------------------

/**
 * Depth cap. 7 because the deepest render-relevant discriminator in the
 * seeded corpus — entry.message.content[].input.todos[].status, whose walk
 * needs depth 7 to REACH the leaf under it (root=0, status leaf read at
 * depth 7) — must not clip. Beyond the cap we emit a `<deep>` marker so two
 * payloads differing only below it intentionally merge.
 */
export const MAX_SHAPE_DEPTH = 7

/**
 * Hard bound on emitted paths. Truncation is explicit: the final path is
 * `<truncated-paths>` so a clipped shape can never silently collide with an
 * unclipped one that happens to share the surviving prefix.
 */
export const MAX_SHAPE_PATHS = 512

/**
 * Hard bound on TRAVERSAL work, not just output (review finding: capping
 * only the returned paths still let a 500k-key payload cost ~700ms of
 * synchronous walk on the paint path — the renderer-freeze class this
 * system exists to prevent). Once the walk has visited this many nodes it
 * stops descending and stamps `<truncated-paths>`; the marker keeps clipped
 * and unclipped shapes distinct, same as the path cap.
 */
export const MAX_VISITED_NODES = 20_000

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
 * TOP-LEVEL discriminator values must look like an enum token, not prose.
 * Length ≤64 and no whitespace/slashes keeps prompts, sentences, and paths
 * out. Mixed case allowed because real tool names are PascalCase (Bash,
 * TodoWrite, mcp__server__tool).
 */
const DISCRIMINATOR_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/
/**
 * NESTED discriminator values get a STRICTER gate (review finding A4): a
 * nested `type`/`kind`/`subtype` in an MCP/custom payload is user-shaped
 * JSON, and the loose token regex would pass hex secrets or internal IDs.
 * Provider wire enums are lowercase snake (text, tool_use, function_call,
 * patch_apply_end, compact_boundary), so require exactly that shape and a
 * letter start, capped at 24 chars — the longest real enum in the corpus is
 * custom_tool_call_output (23), while a 32-hex secret is 32. Rejection
 * means "excluded from identity", never "recorded anyway" — failing open
 * would leak content into checked-in catalogs.
 */
const NESTED_DISCRIMINATOR_TOKEN = /^[a-z][a-z0-9_]{0,23}$/

/**
 * Object KEY names are structural only when identifier-shaped. Real wire
 * schemas use snake/camel identifiers; a key carrying a slash, space, dot
 * (paths, URLs, prompts, filenames — codex patch results key `changes` by
 * ABSOLUTE PATH) is content wearing a key's clothes. Such keys collapse to
 * the single `<dyn>` segment: their SUBTREES still contribute structure,
 * but the names never reach shapePaths/catalogs and a thousand filenames
 * are one shape, not a thousand.
 */
const STRUCTURAL_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/

// Separators built via fromCharCode so this file can never again contain
// literal control BYTES (the review panel found the observer's dedup key
// shipped raw NULs, turning the file binary in git — unreviewable).
const PATH_SEP = String.fromCharCode(0)
const SECTION_SEP = String.fromCharCode(1)

export type ShapeFingerprintInput = {
  provider: AgentProviderKind | 'unknown'
  /**
   * Observation-plane label, part of the identity. Deliberately `string`,
   * not `RenderShapePlane`: two vocabularies legitimately flow through here
   * — the observer's RenderShapePlane (Phase 2) and the ledger's
   * RenderSourcePlane (the unknown registry). The helper canonicalizes
   * whatever plane vocabulary the observation site uses; constraining the
   * union is the caller's layer's job.
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
  /** Human-readable typed key paths (content-free by the STRUCTURAL_KEY
   *  gate) — what the fingerprint denotes, carried so inbox readers never
   *  re-derive it from payloads. */
  shapePaths: readonly string[]
  /** Allowlisted low-cardinality structural values, keyed by path. A path
   *  under a merged array segment may carry MULTIPLE values (sorted,
   *  `|`-joined) — the order-free union is what keeps [text, tool_use] and
   *  [tool_use, text] one shape (review finding #1). */
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

type Walk = {
  paths: Set<string>
  /** Discriminator path → SET of observed values. Sets, not last-wins: a
   *  merged `[]` segment sees every element's value, and identity must be
   *  the order-free union. */
  discriminators: Map<string, Set<string>>
  visited: number
  truncated: boolean
}

/**
 * Walk the payload, collecting sorted typed key paths and discriminators.
 *
 * Arrays: all elements merge into ONE element shape under the `[]` segment
 * (sorted-set union of their paths AND their discriminator values). Length
 * and element order must not matter — provider batches reorder freely.
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
  walk: Walk,
): void {
  if (walk.visited >= MAX_VISITED_NODES) {
    walk.truncated = true
    return
  }
  walk.visited += 1
  const t = leafType(value)

  if (t !== 'object' && t !== 'array') {
    walk.paths.add(prefix ? `${prefix}:${t}` : `<root>:${t}`)
    return
  }

  const obj = value as object
  if (ancestors.has(obj)) {
    walk.paths.add(`${prefix || '<root>'}:<cycle>`)
    return
  }
  if (depth >= MAX_SHAPE_DEPTH) {
    walk.paths.add(`${prefix || '<root>'}:<deep>`)
    return
  }

  ancestors.add(obj)
  try {
    if (t === 'array') {
      const arr = value as unknown[]
      walk.paths.add(prefix ? `${prefix}:array` : '<root>:array')
      for (const element of arr) {
        // JSON-PARITY: undefined element serializes as null — see header.
        collectPaths(
          element === undefined ? null : element,
          `${prefix}[]`,
          depth + 1,
          false,
          ancestors,
          walk,
        )
      }
      return
    }

    walk.paths.add(prefix ? `${prefix}:object` : '<root>:object')
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      const child = (obj as Record<string, unknown>)[key]
      // JSON-PARITY: undefined-valued key serializes as absent — see header.
      if (child === undefined) continue
      if (SENSITIVE_KEY.test(key)) {
        // Key NAME retained, VALUE/subtree never walked — the value's own
        // structure must not influence identity (a string token and an
        // object credential under `authorization` are the same shape).
        walk.paths.add(`${prefix ? `${prefix}.` : ''}${key}=<redacted-key>`)
        continue
      }
      // Non-identifier keys are CONTENT (paths/URLs/prompts as map keys) —
      // collapse to <dyn> so the name never leaks and a keyed map is one
      // shape regardless of its keys. Subtree structure still contributes.
      const safeKey = STRUCTURAL_KEY.test(key) ? key : '<dyn>'
      const path = prefix ? `${prefix}.${safeKey}` : safeKey
      const eligible =
        (DISCRIMINATOR_KEYS_ANY_DEPTH.has(key) &&
          typeof child === 'string' &&
          (topLevel ? DISCRIMINATOR_TOKEN : NESTED_DISCRIMINATOR_TOKEN).test(child)) ||
        (topLevel &&
          DISCRIMINATOR_KEYS_TOP_LEVEL.has(key) &&
          typeof child === 'string' &&
          DISCRIMINATOR_TOKEN.test(child))
      if (eligible) {
        const set = walk.discriminators.get(path) ?? new Set<string>()
        set.add(child as string)
        walk.discriminators.set(path, set)
      }
      collectPaths(child, path, depth + 1, false, ancestors, walk)
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
  const walk: Walk = {
    paths: new Set<string>(),
    discriminators: new Map<string, Set<string>>(),
    visited: 0,
    truncated: false,
  }
  collectPaths(input.payload, '', 0, true, new Set(), walk)

  // Canonical order AFTER collection: identity must not depend on insertion
  // order (arrays merge element paths in element order; objects are sorted
  // per level but interleave with their children). One global sort makes the
  // serialization insensitive to walk order by construction.
  let shapePaths = [...walk.paths].sort()
  if (shapePaths.length > MAX_SHAPE_PATHS || walk.truncated) {
    shapePaths = shapePaths.slice(0, MAX_SHAPE_PATHS)
    shapePaths.push('<truncated-paths>')
  }

  // Multi-value paths join their SORTED value set with '|' — deterministic
  // under any element order, and `|` cannot appear in values that passed
  // either discriminator regex.
  const discriminatorValues: Record<string, string> = {}
  for (const key of [...walk.discriminators.keys()].sort()) {
    discriminatorValues[key] = [...walk.discriminators.get(key)!].sort().join('|')
  }

  // Control-char separators (built via fromCharCode, never literal bytes):
  // \u0000 cannot survive either discriminator regex and is vanishingly
  // rare in key names, and \u0001 joins the five sections — so cross-
  // boundary gluing ("ab"+"c" vs "a"+"bc") cannot produce collisions for
  // any realistic input. FNV collisions merely merge two catalog groups.
  const canonical = [
    input.provider,
    input.plane,
    input.eventType,
    shapePaths.join(PATH_SEP),
    Object.entries(discriminatorValues)
      .map(([k, v]) => `${k}=${v}`)
      .join(PATH_SEP),
  ].join(SECTION_SEP)

  return {
    fingerprint: `fp1-${fnv1a(canonical)}`,
    shapePaths,
    discriminatorValues,
  }
}
