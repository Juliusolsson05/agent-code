// Pure presentation helpers for the generic JSON tool row (JsonToolRow).
// Split from the component so the payload→presentation mapping is unit-
// testable without rendering (the corpus bundles are the test inputs:
// docs/rendering/research-2026-07/plan-json-tool-rows.md).

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
 * - `command` first (Bash-shaped tools; the identifier IS the action)
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
  'path',
  'notebook_path',
  'url',
  'pattern',
  'query',
  'title',
  'name',
  'prompt',
  'sessionId',
  'description',
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

export function isAbsolutePathLike(s: string): boolean {
  return /^(~\/|\/)[^\0\n]*$/.test(s) && s.length < 512
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s) && s.length < 2048
}

/**
 * Best-effort JSON extraction from tool RESULT text. Handles, in order:
 * 1. the MCP text envelope `[{"type":"text","text":"<json>"}]` (one level)
 * 2. codex's `Wall time: …\nOutput:\n<json>` wrapper
 * 3. plain JSON
 * Returns null when the text is not JSON-shaped — callers fall through to
 * the existing truncated-text rendering, so this can never make a result
 * LESS readable than today.
 */
export function tryExtractJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 256 * 1024) return null

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

  const parsed = parse(candidate)
  if (parsed === null) return null

  // MCP text envelope: [{type:'text', text:'<inner json or text>'}].
  if (
    Array.isArray(parsed) &&
    parsed.length === 1 &&
    typeof parsed[0] === 'object' &&
    parsed[0] !== null &&
    (parsed[0] as { type?: unknown }).type === 'text' &&
    typeof (parsed[0] as { text?: unknown }).text === 'string'
  ) {
    const inner = parse((parsed[0] as { text: string }).text)
    return inner ?? parsed
  }
  return parsed
}

/** One-line summary for a collapsed JSON result. `ok` is the universal
 *  status key across the orchestration/workspace corpus payloads. */
export function jsonResultSummary(value: unknown): { label: string; isError: boolean } {
  if (Array.isArray(value)) return { label: `${value.length} items`, isError: false }
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    if (rec.ok === false) return { label: 'ok: false', isError: true }
    if (rec.ok === true) return { label: 'ok: true', isError: false }
    return { label: `${Object.keys(rec).length} keys`, isError: false }
  }
  return { label: String(value).slice(0, 60), isError: false }
}
