// Pure presentation helpers for the generic JSON tool row (JsonToolRow).
// Split from the component so the payload→presentation mapping is unit-
// testable without rendering (the corpus bundles are the test inputs:
// docs/rendering/research-2026-07/plan-json-tool-rows.md).

import { boundedTextPage } from '@renderer/lib/text/boundedText'

const COMMAND_HEADLINE_MAX_LINES = 2
const COMMAND_HEADLINE_MAX_CHARS = 160

/** Bound a generic `command` headline without knowing the provider or tool.
 *
 * WHY the field key owns this rule instead of names such as Bash, bash, or
 * exec_command: JsonToolRow is the open-world fallback reached precisely when
 * a provider did not claim the tool. A new provider can still use the common
 * `{command:string}` grammar, and rendering its megabyte heredoc eagerly just
 * because its tool name is unfamiliar would make the safety budget depend on
 * provider vocabulary. The exact input remains in the expandable parameters /
 * transcript; this is only the compact two-line headline. */
export function boundedCommandHeadline(command: string): string {
  const page = boundedTextPage(
    command,
    0,
    COMMAND_HEADLINE_MAX_CHARS,
    COMMAND_HEADLINE_MAX_LINES,
  )
  return page.hasNext ? `${page.text.trimEnd()}…` : page.text
}

/** `mcp__<server>__<tool>` → tool display name + MCP badge. Claude names
 *  MCP tools with the double-underscore convention; codex strips the
 *  prefix upstream so bare names pass through untouched. */
export function prettifyToolName(name: string): {
  display: string
  mcpServer: string | null
} {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (!m) return { display: name, mcpServer: null }
  return { display: m[2], mcpServer: m[1] }
}

/**
 * Unified smart headline for tool inputs — merges the two chains that had
 * drifted apart (shared ToolUseRow.pickString and codex headlineForTool).
 *
 * ORDER MATTERS and is evidence-driven:
 * - `command` first (shell-shaped tools; the identifier IS the action)
 * - path-shaped keys BEFORE `title`/`description` — the corpus caught
 *   `ai_workspace_attach_file` showing its `description` gloss while
 *   hiding the actual `path` (plan §1b); a path is an identifier, a
 *   description is commentary.
 * - MCP-payload keys (`title`, `name`, `prompt`, `sessionId`) next — the
 *   orchestration/workspace tools carry these as their subject line.
 * - `description` LAST: if we reach it we've exhausted every specific
 *   identifier.
 */
const HEADLINE_KEYS = [
  'command',
  'file_path',
  // opencode camelCase twin (probe-verified: read/edit pass filePath).
  'filePath',
  'notebook_path',
  'url',
  // pattern BEFORE path: for Glob/Grep-shaped inputs the pattern is the
  // SUBJECT and path is the scope — the opencode glob bundle showed the
  // cwd as headline while the pattern (what the user cares about) hid in
  // the params slab. Tools whose subject is a path (Read/Edit) carry it
  // as file_path/filePath, which already ranked above.
  'pattern',
  'query',
  'path',
  'title',
  'name',
  'prompt',
  'sessionId',
  'description',
  // Codex fallback keys, LAST so they never outrank a real identifier.
  // When an unknown Codex tool call can't be mapped to a structured input,
  // the mapper degrades it to `{arguments: <raw string>}` (or `{raw: …}`).
  // Without these two keys HEADLINE_KEYS matched nothing and the row
  // collapsed to name-only, hiding the one string we DO have. They sit
  // after `description` so a well-formed tool that also happens to carry an
  // `arguments`/`raw` field still headlines on its specific key first.
  'arguments',
  'raw',
] as const

export function smartHeadline(input: Record<string, unknown> | null | undefined): {
  key: string
  value: string
} | null {
  if (!input) return null
  for (const key of HEADLINE_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return { key, value: v }
  }
  return null
}

/** Params worth a collapsed slab = everything except the one already shown
 *  as the headline. */
export function slabEntries(
  input: Record<string, unknown> | null | undefined,
  headlineKey: string | null,
): [string, unknown][] {
  if (!input) return []
  return Object.entries(input).filter(([k]) => k !== headlineKey)
}

export const MAX_SLAB_PARAMS = 40

/**
 * Return a bounded top-level parameter prefix without allocating all keys.
 *
 * WHY this is separate from `slabEntries`: that older helper is still useful
 * in small pure-presentation tests, but it uses `Object.entries` and therefore
 * cannot defend a renderer boundary. Tool inputs are provider data, not trusted
 * UI models; a generated map with hundreds of thousands of keys must cost the
 * same as forty ordinary parameters when the row is collapsed.
 */
export function boundedSlabEntries(
  input: Record<string, unknown> | null | undefined,
  headlineKey: string | null,
): { entries: [string, unknown][]; hasMore: boolean } {
  if (!input) return { entries: [], hasMore: false }

  const entries: [string, unknown][] = []
  for (const key in input) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || key === headlineKey) {
      continue
    }
    if (entries.length >= MAX_SLAB_PARAMS) {
      return { entries, hasMore: true }
    }
    entries.push([key, input[key]])
  }
  return { entries, hasMore: false }
}

export function isAbsolutePathLike(s: string): boolean {
  // Length cap guards the classifier, not the value: a "path" longer than a
  // real filesystem limit (~512 chars is already generous vs PATH_MAX) is
  // almost certainly prose that merely starts with `/` or `~/`, and mis-
  // classifying it as a path would route it through path-shortening display
  // that mangles the text. Bounding the regex input also keeps it linear.
  return s.length < 512 && /^(~\/|\/)[^\0\n]*$/.test(s)
}

export function isHttpUrl(s: string): boolean {
  // Same guard as isAbsolutePathLike: past ~2KB a "URL" is far more likely a
  // token/blob that happens to start with http(s):// than a real link, and we
  // don't want to wrap 2KB of text in an <a>. 2KB matches the de-facto
  // browser URL-length ceiling, so anything longer wouldn't navigate anyway.
  return s.length < 2048 && /^https?:\/\/\S+$/.test(s)
}

/**
 * Best-effort JSON extraction from tool RESULT text. Handles, in order:
 * 1. MCP text envelopes (`[{"type":"text",...}]` and the newer
 *    `{content:[{"type":"text",...}]}` CallToolResult wrapper)
 * 2. codex's `Wall time: …\nOutput:\n<json>` wrapper
 * 3. plain JSON
 * Returns null when the text is not JSON-shaped — callers fall through to
 * the existing truncated-text rendering, so this can never make a result
 * LESS readable than today.
 */
export function tryExtractJson(text: string): unknown | null {
  // WHY length is checked before trim: String#trim allocates a second string.
  // A non-JSON multi-megabyte command result should fall through to the paged
  // text viewer without first being copied merely to discover it exceeds the
  // parser budget.
  if (text.length > 256 * 1024) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  const parse = (s: string): unknown | null => {
    const t = s.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return null
    try {
      return JSON.parse(t)
    } catch {
      return null
    }
  }

  // Codex wall-time wrapper.
  const wallTime = /^Wall time: [^\n]*\nOutput:\n([\s\S]*)$/.exec(trimmed)
  const candidate = wallTime ? wallTime[1] : trimmed

  let parsed = parse(candidate)
  if (parsed === null) return null

  // WHY peel only two explicitly-known MCP transport wrappers instead of
  // recursively hunting every `text` property: arbitrary MCP schemas are not
  // ours. A domain object may legitimately contain `{ text: "{...}" }`, and
  // treating that as an envelope would discard sibling semantics. The two
  // shapes below are protocol carriers emitted by MCP SDK/tool transports,
  // not application payloads. A small depth cap admits the real Codex shape
  // (`CallToolResult` -> content[] -> JSON text) plus one accidental nested
  // carrier while making malformed self-similar input constant-work.
  for (let depth = 0; depth < 3; depth += 1) {
    let envelopeText: string | null = null

    // Claude transcript normalization commonly stores the content array
    // itself. Extra fields on the text block make it typed MCP content rather
    // than the transparent JSON carrier we know, so keep that array visible.
    if (Array.isArray(parsed) && parsed.length === 1) {
      const item = parsed[0]
      if (
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string' &&
        Object.keys(item).every(key => key === 'type' || key === 'text')
      ) {
        envelopeText = (item as { text: string }).text
      }
    } else if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const keys = Object.keys(record)
      const content = record.content
      // Current tool orchestration surfaces the MCP SDK's full CallToolResult
      // object. A missing/false `isError` adds no error evidence, so the nested
      // JSON can be shown directly. A TRUE or malformed value must remain on
      // screen: generic MCP payloads are open-world and need not duplicate the
      // transport error in an inner `ok` field. Any other sibling key may also
      // carry semantics, so an unfamiliar wrapper stays pretty-printed intact.
      if (
        keys.every(key => key === 'content' || key === 'isError') &&
        (record.isError === undefined || record.isError === false) &&
        Array.isArray(content) &&
        content.length === 1
      ) {
        const item = content[0]
        if (
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          (item as { type?: unknown }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string' &&
          Object.keys(item).every(key => key === 'type' || key === 'text')
        ) {
          envelopeText = (item as { text: string }).text
        }
      }
    }

    if (envelopeText === null) break
    const inner = parse(envelopeText)
    // Plain-prose MCP results are still structured evidence (content type,
    // transport error bit). Retain their carrier instead of collapsing them
    // to a string that loses those facts.
    if (inner === null) break
    parsed = inner
  }

  return parsed
}

/** One-line summary for a collapsed JSON result. `ok` is the universal
 *  status key across the orchestration/workspace corpus payloads. */
export function jsonResultSummary(value: unknown): { label: string; isError: boolean } {
  if (Array.isArray(value)) return { label: `${value.length} items`, isError: false }
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    // Serialized MCP CallToolResult transport errors can reach the generic
    // fallback without becoming ToolResultBlock.is_error. Preserve that
    // explicit provider evidence in both the collapsed label and danger tone.
    if (rec.isError === true) return { label: 'isError: true', isError: true }
    if (rec.ok === false) return { label: 'ok: false', isError: true }
    if (rec.ok === true) return { label: 'ok: true', isError: false }
    // WHY literal discriminators outrank an anonymous key count: projected
    // status/MCP objects often intentionally omit their transport-level `ok`
    // field. Showing `4 keys` then hides the only useful collapsed evidence.
    // This is a shallow allowlist with strict scalar bounds—not recursive
    // schema inference—so arbitrary domain objects keep the generic fallback.
    for (const key of ['status', 'state', 'type', 'kind', 'action'] as const) {
      const discriminator = boundedSummaryScalar(rec[key])
      if (discriminator === null) continue
      const cursor = boundedSummaryScalar(rec.cursor)
      const runId = boundedSummaryScalar(rec.runId)
      const id = boundedSummaryScalar(rec.id)
      const identity = cursor !== null
        ? `cursor ${cursor}`
        : runId !== null
          ? `run ${runId}`
          : id
      const failed = typeof rec[key] === 'string' && /^(?:error|failed|failure|cancelled)$/i.test(rec[key])
      return {
        label: `${key}: ${discriminator}${identity === null ? '' : ` · ${identity}`}`,
        isError: failed,
      }
    }
    // WHY this deliberately stops counting: a summary must never enumerate an
    // untrusted generated map just to print an exact integer. "40+" conveys the
    // useful shape while keeping the closed-row cost constant.
    let keyCount = 0
    for (const key in rec) {
      if (!Object.prototype.hasOwnProperty.call(rec, key)) continue
      keyCount += 1
      if (keyCount >= MAX_SLAB_PARAMS) {
        return { label: `${MAX_SLAB_PARAMS}+ keys`, isError: false }
      }
    }
    return { label: `${keyCount} ${keyCount === 1 ? 'key' : 'keys'}`, isError: false }
  }
  return { label: String(value).slice(0, 60), isError: false }
}

function boundedSummaryScalar(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 80 ||
    !/\S/.test(value)
  ) return null
  return value.replace(/\s+/g, ' ').trim()
}
