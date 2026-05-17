export type RenderedLocalFileTarget = {
  kind: 'local-file'
  path: string
  line: number | null
  column: number | null
}

export type RenderedExternalUrlTarget = {
  kind: 'external-url'
  url: string
}

export type RenderedUnsupportedTarget = {
  kind: 'unsupported'
  reason:
    | 'empty'
    | 'unsafe-protocol'
    | 'malformed-url'
    | 'missing-workspace-root'
    | 'outside-workspace'
    | 'not-a-file-path'
}

export type RenderedTarget =
  | RenderedLocalFileTarget
  | RenderedExternalUrlTarget
  | RenderedUnsupportedTarget

export type RenderedTargetContext = {
  workspaceRoot?: string | null
}

export function normalizeAllowedExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

type ParsedPathSuffix = {
  path: string
  line: number | null
  column: number | null
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

export function parsePathLineColumnSuffix(rawPath: string): ParsedPathSuffix {
  const match = rawPath.match(/^(.*?):(\d+)(?::(\d+))?$/)
  if (!match) return { path: rawPath, line: null, column: null }

  const basePath = match[1] ?? ''
  const line = parsePositiveInt(match[2])
  const column = parsePositiveInt(match[3])
  if (!basePath || line === null || (match[3] !== undefined && column === null)) {
    return { path: rawPath, line: null, column: null }
  }
  return { path: basePath, line, column }
}

function normalizeWorkspaceRoot(root: string | null | undefined): string | null {
  if (!root) return null
  const trimmed = root.trim().replace(/\/+$/, '')
  return trimmed || null
}

function stripWorkspaceRoot(absPath: string, workspaceRoot: string): string | null {
  const root = normalizeWorkspaceRoot(workspaceRoot)
  if (!root) return null
  const normalizedAbs = absPath.replace(/\/+$/, '')
  if (normalizedAbs === root) return ''
  const prefix = `${root}/`
  if (!normalizedAbs.startsWith(prefix)) return null
  return normalizedAbs.slice(prefix.length)
}

function normalizeRelativeCandidate(path: string): string | null {
  const normalized = path.replace(/^\.\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized === '.') return null
  if (normalized.startsWith('/')) return null
  if (normalized.startsWith('../') || normalized === '..') return null
  if (normalized.includes('/../') || normalized.endsWith('/..')) return null
  if (normalized.includes('\0')) return null
  if (normalized.includes(':')) return null
  return normalized
}

function looksLikeRelativeFilePath(path: string): boolean {
  if (path.startsWith('./')) return true
  if (path.includes('/')) return true
  return /^[^/\s]+\.[^/\s.]+$/.test(path)
}

function isKnownUnsafeScheme(raw: string): boolean {
  return /^(?:javascript|data|file|mailto|tel|blob|about|chrome|devtools|vscode):/i.test(raw)
}

function hasExplicitUrlScheme(raw: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)
}

export function classifyRenderedTarget(
  rawTarget: string | null | undefined,
  context: RenderedTargetContext = {},
): RenderedTarget {
  const raw = (rawTarget ?? '').trim()
  if (!raw) return { kind: 'unsupported', reason: 'empty' }

  if (/^https?:\/\//i.test(raw)) {
    const url = normalizeAllowedExternalUrl(raw)
    return url
      ? { kind: 'external-url', url }
      : { kind: 'unsupported', reason: 'malformed-url' }
  }

  if (isKnownUnsafeScheme(raw)) {
    return { kind: 'unsupported', reason: 'unsafe-protocol' }
  }

  if (hasExplicitUrlScheme(raw)) {
    return { kind: 'unsupported', reason: 'unsafe-protocol' }
  }

  if (raw.startsWith('#') || raw.startsWith('?') || raw.startsWith('//')) {
    return { kind: 'unsupported', reason: 'not-a-file-path' }
  }

  const parsed = parsePathLineColumnSuffix(raw)
  const workspaceRoot = normalizeWorkspaceRoot(context.workspaceRoot)

  // Rendered assistant/provider content is untrusted, so path support is
  // intentionally workspace-scoped. Absolute paths are only actionable when
  // they point back into the active session root, and relative paths are read
  // through the existing editor-fs IPC where main repeats containment checks.
  if (parsed.path.startsWith('/')) {
    if (!workspaceRoot) return { kind: 'unsupported', reason: 'missing-workspace-root' }
    const relative = stripWorkspaceRoot(parsed.path, workspaceRoot)
    if (relative === null) return { kind: 'unsupported', reason: 'outside-workspace' }
    const normalized = normalizeRelativeCandidate(relative)
    if (!normalized) return { kind: 'unsupported', reason: 'not-a-file-path' }
    return {
      kind: 'local-file',
      path: normalized,
      line: parsed.line,
      column: parsed.column,
    }
  }

  if (!workspaceRoot) return { kind: 'unsupported', reason: 'missing-workspace-root' }
  if (!looksLikeRelativeFilePath(parsed.path)) {
    return { kind: 'unsupported', reason: 'not-a-file-path' }
  }
  const normalized = normalizeRelativeCandidate(parsed.path)
  if (!normalized) return { kind: 'unsupported', reason: 'not-a-file-path' }
  return {
    kind: 'local-file',
    path: normalized,
    line: parsed.line,
    column: parsed.column,
  }
}
