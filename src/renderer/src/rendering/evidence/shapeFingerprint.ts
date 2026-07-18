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
 * Hard bound on emitted evidence paths. Truncation is explicit in
 * `shapePaths`, but deliberately absent from the hashed identity: reaching a
 * safety budget is a property of the recorder, not a new provider shape. The
 * surviving bounded prefix remains the identity in either case.
 */
export const MAX_SHAPE_PATHS = 512

/**
 * Hard bound on TRAVERSAL work, not just output (review finding: capping
 * only the returned paths still let a 500k-key payload cost ~700ms of
 * synchronous walk on the paint path — the renderer-freeze class this
 * system exists to prevent). Once the walk has visited this many nodes it
 * stops descending and stamps `<truncated-paths>` in human evidence only.
 * Making that marker part of the fingerprint used to mint a second catalog
 * identity merely because a repeated homogeneous payload crossed the budget.
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

/** Captured provider enums that are safe to use as nested scalar identity.
 *
 * WHY a shape regex is not sufficient: an MCP input such as
 * `{type:"hunter2"}` also looks like a lowercase enum token, so the previous
 * gate let arbitrary short secrets alter the fingerprint despite the
 * content-free identity contract. Nested provider data is open-world; adding
 * a new structural enum must therefore be a reviewed vocabulary change backed
 * by fixture evidence, not an automatic promotion of every token-shaped
 * scalar. Top-level tool/event names retain their separate structural gate.
 */
const NESTED_DISCRIMINATOR_VALUES = new Set([
  'add',
  'agent_listing_delta',
  'assistant',
  'attachment',
  'claude',
  'codex',
  'command_permissions',
  'compact_boundary',
  'compaction',
  'create',
  'custom_tool_call',
  'custom_tool_call_output',
  'deferred_tools_delta',
  'delete',
  'direct',
  'edited_text_file',
  'file',
  'function_call',
  'hook_additional_context',
  'hook_success',
  'human',
  'input_text',
  'mcp_instructions_delta',
  'message',
  'messages_changed',
  'nested_memory',
  'open_page',
  'opencode',
  'patch_apply_end',
  'queued_command',
  'reasoning',
  'response_item',
  'search',
  'skill_listing',
  'system',
  'system_changed',
  'task_reminder',
  'text',
  'thinking',
  'tool_reference',
  'tool_result',
  'tool_use',
  'tools_changed',
  'turn_duration',
  'update',
  'user',
  'web_search_call',
])

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

export const CURRENT_RENDER_SHAPE_FINGERPRINT_VERSION = 'fp2'

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

/** Pick a stable representative grammar for an array whose cardinality hits
 * the local scan cap.
 *
 * WHY wide arrays need a representative rather than a `<capped-array>` token:
 * the token made 1,023 and 1,024 identical records produce different shape
 * ids. Hashing the whole admitted prefix instead makes equivalent reordered
 * arrays depend on which rare member lands just before the cutoff. This small
 * bounded signature groups members by structure (and only allowlisted enum
 * discriminators), then chooses the most common group with a lexical tie
 * break. The main walker still owns the authoritative path collection and its
 * 4,000-node budget; this classifier is capped independently so choosing the
 * representative cannot reopen unbounded paint work.
 */
function boundedArrayMemberSignature(value: unknown): string {
  let remainingNodes = 64
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    if (remainingNodes <= 0) return '<member-cap>'
    remainingNodes -= 1
    const type = leafType(item)
    if (type !== 'object' && type !== 'array') return type
    if (depth >= 4) return `${type}:<deep>`
    const object = item as object
    if (ancestors.has(object)) return `${type}:<cycle>`
    ancestors.add(object)
    try {
      if (type === 'array') {
        const members = (item as unknown[]).slice(0, 8).map(member => visit(member, depth + 1))
        return `array[${[...new Set(members)].sort().join(',')}]`
      }
      const record = item as Record<string, unknown>
      const keys: string[] = []
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue
        if (keys.length >= 16) break
        keys.push(key)
      }
      keys.sort()
      const fields = keys.map(key => {
        const child = record[key]
        const identityKey = STRUCTURAL_IDENTITY_KEY.test(key) ? key : '<dyn>'
        const discriminator = DISCRIMINATOR_KEYS_ANY_DEPTH.has(key) &&
          typeof child === 'string' &&
          NESTED_DISCRIMINATOR_TOKEN.test(child) &&
          NESTED_DISCRIMINATOR_VALUES.has(child)
          ? `=${child}`
          : ''
        return `${identityKey}${discriminator}:${visit(child, depth + 1)}`
      })
      return `object{${fields.join(',')}}`
    } finally {
      ancestors.delete(object)
    }
  }
  return visit(value === undefined ? null : value, 0)
}

function representativeArrayIndex(arr: readonly unknown[], admitted: number): number {
  const groups = new Map<string, { count: number; firstIndex: number }>()
  for (let index = 0; index < admitted; index += 1) {
    const signature = boundedArrayMemberSignature(arr[index])
    const group = groups.get(signature)
    if (group) group.count += 1
    else groups.set(signature, { count: 1, firstIndex: index })
  }
  let winner: { signature: string; count: number; firstIndex: number } | null = null
  for (const [signature, group] of groups) {
    if (
      winner === null ||
      group.count > winner.count ||
      (group.count === winner.count && signature < winner.signature)
    ) {
      winner = { signature, ...group }
    }
  }
  return winner?.firstIndex ?? 0
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
      const hasUnscannedArrayTail = arr.length > admitted
      const usesCollapsedArrayIdentity = arr.length >= MAX_ARRAY_ITEMS_SCANNED
      if (hasUnscannedArrayTail) walk.truncated = true
      const representative = usesCollapsedArrayIdentity
        ? representativeArrayIndex(arr, admitted)
        : -1
      // Visit the representative first so diagnostics from many repeated
      // members cannot consume the global node budget before the identity
      // grammar is collected. Remaining members still contribute bounded
      // human evidence but cannot churn the wide-array fingerprint.
      const visitOrder = representative < 0
        ? Array.from({ length: admitted }, (_, index) => index)
        : [representative, ...Array.from({ length: admitted }, (_, index) => index)
          .filter(index => index !== representative)]
      for (const index of visitOrder) {
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
          identitySuppressed || (usesCollapsedArrayIdentity && index !== representative),
          depth + 1,
          false,
          ancestors,
          walk,
        )
      }
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
    const usesCollapsedObjectIdentity = keys.length >= MAX_OBJECT_KEYS_SCANNED
    if (usesCollapsedObjectIdentity && !identitySuppressed) {
      // WHY the admitted keys do not enter identity for a wide object: the
      // first 1,024 enumerable keys are insertion-order dependent. Sorting
      // that prefix is insufficient because an equivalent object inserted in
      // reverse order admits a different set. Discovering a global smallest
      // key set would require walking the unbounded tail. The collapsed marker
      // preserves the hard local work cap and makes equivalent wide schemas
      // deterministic; literal prefix keys remain available in shapePaths for
      // diagnosis, but cannot churn a pinned catalog fingerprint.
      walk.identityPaths.add(`${identityPrefix || '<root>'}:<capped-object>`)
    }
    for (const key of keys) {
      if (walk.visited >= MAX_VISITED_NODES || walk.paths.size >= MAX_SHAPE_PATHS) {
        walk.truncated = true
        break
      }
      const child = record[key]
      // JSON-PARITY: undefined-valued key serializes as absent — see header.
      if (child === undefined) continue
      const path = prefix ? `${prefix}.${key}` : key
      // Wide-object identity is deliberately collapsed above. Do not let a
      // sensitive marker or discriminator escape that collapse: which keys
      // happen to enter the bounded insertion-order window is not grammar.
      const sensitiveIdentity =
        !identitySuppressed && !usesCollapsedObjectIdentity && SENSITIVE_KEY.test(key)
      // Stable identifier-shaped keys remain structural even when their VALUE
      // is sensitive (`authorization`, `api_key`, `max_output_tokens`). Only
      // open-world map keys collapse to <dyn>. The historical leak was below:
      // the redacted marker rebuilt a path from raw `key`, bypassing this
      // already-computed identityKey for non-structural sensitive names.
      const identityKey = STRUCTURAL_IDENTITY_KEY.test(key) ? key : '<dyn>'
      const identityPath = identityPrefix ? `${identityPrefix}.${identityKey}` : identityKey
      if (sensitiveIdentity) {
        // Preserve the historical low-cardinality fingerprint recipe while
        // continuing below for the literal evidence path. Auth-shaped values
        // do not mint catalog variants, but their full key/type structure is
        // still present in shapePaths for this dev-only recorder.
        walk.identityPaths.add(`${identityPath}=<redacted-key>`)
      }
      const eligible =
        (DISCRIMINATOR_KEYS_ANY_DEPTH.has(key) &&
          typeof child === 'string' &&
          (topLevel
            ? DISCRIMINATOR_TOKEN.test(child)
            : NESTED_DISCRIMINATOR_TOKEN.test(child) &&
              NESTED_DISCRIMINATOR_VALUES.has(child))) ||
        (topLevel &&
          DISCRIMINATOR_KEYS_TOP_LEVEL.has(key) &&
          typeof child === 'string' &&
          DISCRIMINATOR_TOKEN.test(child))
      if (eligible) {
        const set = walk.discriminators.get(path) ?? new Set<string>()
        set.add(child as string)
        walk.discriminators.set(path, set)
        if (!identitySuppressed && !usesCollapsedObjectIdentity && !sensitiveIdentity) {
          const identitySet = walk.identityDiscriminators.get(identityPath) ?? new Set<string>()
          identitySet.add(child as string)
          walk.identityDiscriminators.set(identityPath, identitySet)
        }
      }
      collectPaths(
        child,
        path,
        identityPath,
        identitySuppressed || usesCollapsedObjectIdentity || sensitiveIdentity,
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
  // WHY no truncation sentinel enters identity: safety caps bound how much we
  // inspect and report; they do not describe provider structure. Hash the
  // bounded paths we actually learned, whether or not evidence reports that a
  // cap stopped the walk. This makes an exactly-at-budget value and the same
  // value plus repeated/capped tail members one catalog shape.
  if (identityPaths.length > MAX_SHAPE_PATHS) {
    identityPaths = identityPaths.slice(0, MAX_SHAPE_PATHS)
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
    fingerprint: `${CURRENT_RENDER_SHAPE_FINGERPRINT_VERSION}-${fnv1a(canonical)}`,
    shapePaths,
    discriminatorValues,
  }
}
