import type { AgentProviderKind } from '@shared/types/providerKind'
import { SENSITIVE_KEY } from '@renderer/rendering/model/sensitiveKey'

// ---------------------------------------------------------------------------
// Structural fingerprint — the canonical shape identity (Phase 1 of the
// evidence-first rendering plan, PR #554/#555).
//
// Answers exactly one question: "have we seen this STRUCTURE before?" —
// where structure means provider + plane + event/tool discriminator + the
// key/type skeleton of the payload, and not its scalar content. `Bash ls` and
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
// algorithm must evolve, version it (the current recipe is fp2) and re-pin
// catalogs in the same PR — do not mutate a released version in place.
//
// DEV-EVIDENCE CONTRACT: key names are evidence, including dynamic MCP map
// keys, paths, and auth-looking keys. This recorder is explicitly a developer
// mode diagnostic and the raw session recording already contains the source
// payload; collapsing keys here made the resulting catalog less useful than
// its source of truth. Scalar values are still omitted because this identity
// answers a structural question, not because this layer is a privacy filter.
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
export const MAX_VISITED_NODES = 4_000

/**
 * Container-local admission caps. A global node budget alone did not bound
 * `Object.keys(...).sort()` or an array's outer iterator: a million-member
 * container still performed a million synchronous steps after the walker had
 * stopped descending. These caps are deliberately below the global budget so
 * one hostile member cannot consume the entire render-frame allowance.
 */
export const MAX_ARRAY_ITEMS_SCANNED = 1_024
export const MAX_OBJECT_KEYS_SCANNED = 1_024

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
 * Catalog identity is intentionally lower-cardinality than captured evidence.
 * Every literal key is returned in shapePaths, but path-like map keys collapse
 * here so one `codex.changes[/absolute/file]` grammar remains one catalog
 * shape. This is not redaction: the literal path stays in the sighting.
 */
const STRUCTURAL_IDENTITY_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/

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
  /** `fp2-<8 hex>` — versioned so a future algorithm change is visible in
   *  every pinned catalog entry instead of silently re-keying them. */
  fingerprint: string
  /** Human-readable typed key paths — what the fingerprint denotes, carried
   *  so inbox readers never re-derive it from payloads. */
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
  identityPaths: Set<string>
  /** Discriminator path → SET of observed values. Sets, not last-wins: a
   *  merged `[]` segment sees every element's value, and identity must be
   *  the order-free union. */
  discriminators: Map<string, Set<string>>
  identityDiscriminators: Map<string, Set<string>>
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
  identityPrefix: string,
  identitySuppressed: boolean,
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
  if (walk.paths.size >= MAX_SHAPE_PATHS) {
    walk.truncated = true
    return
  }
  const t = leafType(value)

  if (t !== 'object' && t !== 'array') {
    walk.paths.add(prefix ? `${prefix}:${t}` : `<root>:${t}`)
    if (!identitySuppressed) {
      walk.identityPaths.add(identityPrefix ? `${identityPrefix}:${t}` : `<root>:${t}`)
    }
    return
  }

  const obj = value as object
  if (ancestors.has(obj)) {
    walk.paths.add(`${prefix || '<root>'}:<cycle>`)
    if (!identitySuppressed) walk.identityPaths.add(`${identityPrefix || '<root>'}:<cycle>`)
    return
  }
  if (depth >= MAX_SHAPE_DEPTH) {
    walk.paths.add(`${prefix || '<root>'}:<deep>`)
    if (!identitySuppressed) walk.identityPaths.add(`${identityPrefix || '<root>'}:<deep>`)
    return
  }

  ancestors.add(obj)
  try {
    if (t === 'array') {
      const arr = value as unknown[]
      walk.paths.add(prefix ? `${prefix}:array` : '<root>:array')
      if (!identitySuppressed) {
        walk.identityPaths.add(identityPrefix ? `${identityPrefix}:array` : '<root>:array')
      }
      const admitted = Math.min(arr.length, MAX_ARRAY_ITEMS_SCANNED)
      for (let index = 0; index < admitted; index += 1) {
        if (walk.visited >= MAX_VISITED_NODES || walk.paths.size >= MAX_SHAPE_PATHS) {
          walk.truncated = true
          break
        }
        const element = arr[index]
        // JSON-PARITY: undefined element serializes as null — see header.
        collectPaths(
          element === undefined ? null : element,
          `${prefix}[]`,
          `${identityPrefix}[]`,
          identitySuppressed,
          depth + 1,
          false,
          ancestors,
          walk,
        )
      }
      if (arr.length > admitted) walk.truncated = true
      return
    }

    walk.paths.add(prefix ? `${prefix}:object` : '<root>:object')
    if (!identitySuppressed) {
      walk.identityPaths.add(identityPrefix ? `${identityPrefix}:object` : '<root>:object')
    }
    // Collect only one bounded key window before sorting. `Object.keys` built
    // and sorted the COMPLETE attacker-controlled key set before the global
    // node cap could fire, which made the advertised cap cosmetic.
    const record = obj as Record<string, unknown>
    const keys: string[] = []
    let hasMoreKeys = false
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue
      if (keys.length >= MAX_OBJECT_KEYS_SCANNED) {
        hasMoreKeys = true
        break
      }
      keys.push(key)
    }
    if (hasMoreKeys) walk.truncated = true
    keys.sort()
    for (const key of keys) {
      if (walk.visited >= MAX_VISITED_NODES || walk.paths.size >= MAX_SHAPE_PATHS) {
        walk.truncated = true
        break
      }
      const child = record[key]
      // JSON-PARITY: undefined-valued key serializes as absent — see header.
      if (child === undefined) continue
      const path = prefix ? `${prefix}.${key}` : key
      const sensitiveIdentity = !identitySuppressed && SENSITIVE_KEY.test(key)
      const identityKey = STRUCTURAL_IDENTITY_KEY.test(key) ? key : '<dyn>'
      const identityPath = identityPrefix ? `${identityPrefix}.${identityKey}` : identityKey
      if (sensitiveIdentity) {
        // Preserve the historical low-cardinality fingerprint recipe while
        // continuing below for the literal evidence path. Auth-shaped values
        // do not mint catalog variants, but their full key/type structure is
        // still present in shapePaths for this dev-only recorder.
        walk.identityPaths.add(`${identityPrefix ? `${identityPrefix}.` : ''}${key}=<redacted-key>`)
      }
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
        if (!identitySuppressed && !sensitiveIdentity) {
          const identitySet = walk.identityDiscriminators.get(identityPath) ?? new Set<string>()
          identitySet.add(child as string)
          walk.identityDiscriminators.set(identityPath, identitySet)
        }
      }
      collectPaths(
        child,
        path,
        identityPath,
        identitySuppressed || sensitiveIdentity,
        depth + 1,
        false,
        ancestors,
        walk,
      )
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
    identityPaths: new Set<string>(),
    discriminators: new Map<string, Set<string>>(),
    identityDiscriminators: new Map<string, Set<string>>(),
    visited: 0,
    truncated: false,
  }
  collectPaths(input.payload, '', '', false, 0, true, new Set(), walk)

  // Canonical order AFTER collection: identity must not depend on insertion
  // order (arrays merge element paths in element order; objects are sorted
  // per level but interleave with their children). One global sort makes the
  // serialization insensitive to walk order by construction.
  let shapePaths = [...walk.paths].sort()
  if (shapePaths.length > MAX_SHAPE_PATHS || walk.truncated) {
    shapePaths = shapePaths.slice(0, MAX_SHAPE_PATHS)
    shapePaths.push('<truncated-paths>')
  }
  let identityPaths = [...walk.identityPaths].sort()
  if (identityPaths.length > MAX_SHAPE_PATHS || walk.truncated) {
    identityPaths = identityPaths.slice(0, MAX_SHAPE_PATHS)
    identityPaths.push('<truncated-paths>')
  }

  // Multi-value paths join their SORTED value set with '|' — deterministic
  // under any element order, and `|` cannot appear in values that passed
  // either discriminator regex.
  const discriminatorValues: Record<string, string> = {}
  for (const key of [...walk.discriminators.keys()].sort()) {
    discriminatorValues[key] = [...walk.discriminators.get(key)!].sort().join('|')
  }
  const identityDiscriminatorValues: Record<string, string> = {}
  for (const key of [...walk.identityDiscriminators.keys()].sort()) {
    identityDiscriminatorValues[key] = [...walk.identityDiscriminators.get(key)!].sort().join('|')
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
    identityPaths.join(PATH_SEP),
    Object.entries(identityDiscriminatorValues)
      .map(([k, v]) => `${k}=${v}`)
      .join(PATH_SEP),
  ].join(SECTION_SEP)

  return {
    fingerprint: `fp2-${fnv1a(canonical)}`,
    shapePaths,
    discriminatorValues,
  }
}
