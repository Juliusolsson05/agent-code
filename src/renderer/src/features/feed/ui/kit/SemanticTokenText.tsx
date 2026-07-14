import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { APP_PROTOCOL_SCHEME } from '@shared/appIdentity'
import {
  languageFileExtension,
  normalizeCodeLanguage,
  supportsLsp,
} from '@shared/code/language'
import type { LspSemanticLegend } from '@shared/types/lsp'

export type SemanticTokenRange = {
  start: number
  length: number
  tokenType: string
  className: string
}

type SemanticSnapshot = {
  content: string
  lines: SemanticTokenRange[][]
}

type SemanticApi = {
  ensureLspLegend(
    workspaceRoot: string,
    language: string,
  ): Promise<LspSemanticLegend | null>
  openLspDocument(params: {
    clientUri: string
    content: string
    language: string
    workspaceRoot: string
    filePath?: string | null
  }): Promise<void>
  changeLspDocument(clientUri: string, content: string): Promise<void>
  closeLspDocument(clientUri: string): Promise<void>
  getLspSemanticTokens(clientUri: string): Promise<{ data: number[] } | null>
}

type SemanticLifecycle = {
  disposed: boolean
  opened: boolean
  latestContent: string
  sentContent: string
  legend: LspSemanticLegend | null
  frame: number | null
  inFlight: boolean
  dirty: boolean
}

// Semantic tokens are optional enrichment and the protocol currently returns a
// full-document array. Beyond this bound lexical color remains immediate and
// accurate; opening and retransmitting a huge generated document would spend
// far more CPU/memory than the extra color can justify.
const SEMANTIC_MAX_CHARS = 100_000

// TypeScript's semantic-token vocabulary is richer than highlight.js's class
// vocabulary. Mapping into the already-shipped hljs theme keeps semantic and
// lexical colors coherent in every app theme without inventing a second token
// palette that future agents would need to maintain independently.
const TOKEN_CLASS: Record<string, string> = {
  namespace: 'hljs-title class_',
  class: 'hljs-title class_',
  enum: 'hljs-title class_',
  interface: 'hljs-title class_',
  struct: 'hljs-title class_',
  type: 'hljs-type',
  typeParameter: 'hljs-type',
  parameter: 'hljs-params',
  variable: 'hljs-variable',
  property: 'hljs-property',
  enumMember: 'hljs-property',
  event: 'hljs-property',
  function: 'hljs-title function_',
  method: 'hljs-title function_',
  // typescript-language-server calls method-like class members simply
  // `member` in its concrete legend (rather than the protocol's `method`).
  member: 'hljs-title function_',
  macro: 'hljs-meta',
  label: 'hljs-symbol',
  comment: 'hljs-comment',
  string: 'hljs-string',
  keyword: 'hljs-keyword',
  number: 'hljs-number',
  regexp: 'hljs-regexp',
  operator: 'hljs-operator',
  decorator: 'hljs-meta',
}

/** Decode the LSP's relative, flat integer stream into per-line ranges. */
export function decodeSemanticTokenLines(
  data: number[],
  legend: LspSemanticLegend,
  content: string,
): SemanticTokenRange[][] | null {
  const sourceLines = content.split('\n')
  const result = sourceLines.map(() => [] as SemanticTokenRange[])
  let line = 0
  let start = 0
  let styledCount = 0

  // SemanticTokens data is five integers per token: deltaLine, deltaStart,
  // length, tokenType index, modifier bitset. A truncated/malformed response is
  // enrichment failure, not a reason to hide source, so incomplete tails are
  // ignored and every range is clamped to its actual UTF-16 source line.
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0
    const deltaStart = data[i + 1] ?? 0
    const length = data[i + 2] ?? 0
    const tokenTypeIndex = data[i + 3] ?? -1
    if (deltaLine < 0 || deltaStart < 0 || length <= 0) continue

    if (deltaLine === 0) {
      start += deltaStart
    } else {
      line += deltaLine
      start = deltaStart
    }
    const source = sourceLines[line]
    const tokenType = legend.tokenTypes[tokenTypeIndex]
    const className = tokenType ? TOKEN_CLASS[tokenType] : undefined
    if (source === undefined || !tokenType || !className || start >= source.length) {
      continue
    }
    const safeLength = Math.min(length, source.length - start)
    if (safeLength <= 0) continue
    result[line]?.push({ start, length: safeLength, tokenType, className })
    styledCount += 1
  }

  // An empty semantic response is common for incomplete hunks. Returning null
  // preserves the richer lexical highlighter instead of replacing it with
  // uncolored text merely because an LSP request technically succeeded.
  return styledCount > 0 ? result : null
}

function scheduleSemanticRefresh(
  lifecycle: SemanticLifecycle,
  api: SemanticApi,
  clientUri: string,
  publish: (snapshot: SemanticSnapshot) => void,
): void {
  if (
    lifecycle.disposed ||
    !lifecycle.opened ||
    !lifecycle.legend
  ) {
    return
  }

  lifecycle.dirty = true
  // Exactly one semantic request may be in flight per document. Provider
  // deltas regularly outrun typescript-language-server; generation numbers
  // discard stale answers but do not stop the server from doing all the stale
  // work. The dirty bit records that one newest replay is needed after the
  // current response settles.
  if (lifecycle.frame !== null || lifecycle.inFlight) return

  lifecycle.frame = window.requestAnimationFrame(() => {
    lifecycle.frame = null
    if (lifecycle.disposed || !lifecycle.legend) return

    lifecycle.dirty = false
    lifecycle.inFlight = true
    const requestedContent = lifecycle.latestContent
    void (async () => {
      try {
        if (lifecycle.sentContent !== requestedContent) {
          // Full-text didChange is the preload contract today. Coalescing here
          // is therefore load-bearing: provider deltas can arrive far faster
          // than the language server can parse them, but the browser only needs
          // the newest source once per visual frame.
          await api.changeLspDocument(clientUri, requestedContent)
          lifecycle.sentContent = requestedContent
        }
        const response = await api.getLspSemanticTokens(clientUri)
        if (
          lifecycle.disposed ||
          lifecycle.latestContent !== requestedContent ||
          !response
        ) {
          return
        }
        const legend = lifecycle.legend
        if (!legend) return
        const lines = decodeSemanticTokenLines(
          response.data,
          legend,
          requestedContent,
        )
        if (lines) publish({ content: requestedContent, lines })
      } catch {
        // Semantic color is a progressive enhancement. The lexical content is
        // already visible and must remain so when the broker/server disappears.
      } finally {
        lifecycle.inFlight = false
        if (
          !lifecycle.disposed &&
          (lifecycle.dirty || lifecycle.latestContent !== requestedContent)
        ) {
          scheduleSemanticRefresh(lifecycle, api, clientUri, publish)
        }
      }
    })()
  })
}

/**
 * Open one stable virtual LSP document and incrementally enrich its source.
 *
 * `documentKey` must describe the operation side (for example patch-id:before),
 * not the current content. Content-derived ids would reopen the language server
 * document on every token and recreate the performance bug this hook replaces.
 */
export function useSemanticTokenLines({
  content,
  language,
  path,
  workspaceRoot,
  documentKey,
  enabled = true,
}: {
  content: string
  language?: string | null
  path?: string | null
  workspaceRoot?: string | null
  documentKey: string
  enabled?: boolean
}): SemanticTokenRange[][] | null {
  const normalizedLanguage = normalizeCodeLanguage(language, path)
  const hasDesktopLsp =
    typeof window !== 'undefined' &&
    typeof window.api?.ensureLspLegend === 'function' &&
    typeof window.api?.getLspSemanticTokens === 'function'
  const active = Boolean(
    enabled &&
    content &&
    content.length <= SEMANTIC_MAX_CHARS &&
    workspaceRoot &&
    supportsLsp(normalizedLanguage) &&
    hasDesktopLsp,
  )
  const clientUri = useMemo(
    () =>
      `${APP_PROTOCOL_SCHEME}://semantic/${encodeURIComponent(documentKey)}.${languageFileExtension(normalizedLanguage)}`,
    [documentKey, normalizedLanguage],
  )
  const lifecycleRef = useRef<SemanticLifecycle | null>(null)
  const [snapshot, setSnapshot] = useState<SemanticSnapshot | null>(null)

  useEffect(() => {
    if (!active || !workspaceRoot) {
      lifecycleRef.current = null
      setSnapshot(null)
      return
    }

    const api = window.api as SemanticApi
    const lifecycle: SemanticLifecycle = {
      disposed: false,
      opened: false,
      latestContent: content,
      sentContent: '',
      legend: null,
      frame: null,
      inFlight: false,
      dirty: false,
    }
    lifecycleRef.current = lifecycle
    setSnapshot(null)

    void (async () => {
      try {
        // Starting legend negotiation before didOpen lets both operations share
        // the server initialization, while awaiting didOpen first guarantees a
        // token request never races a document the broker does not know about.
        const legendPromise = api
          .ensureLspLegend(workspaceRoot, normalizedLanguage)
          .catch(() => null)
        const openedContent = lifecycle.latestContent
        await api.openLspDocument({
          clientUri,
          content: openedContent,
          language: normalizedLanguage,
          workspaceRoot,
          // A virtual document per operation side avoids sending duplicate
          // didOpen notifications for the user's real on-disk URI when before
          // and after views are visible at the same time.
          filePath: null,
        })
        lifecycle.opened = true
        lifecycle.sentContent = openedContent
        if (lifecycle.disposed) {
          lifecycle.opened = false
          void api.closeLspDocument(clientUri)
          return
        }

        lifecycle.legend = await legendPromise
        if (lifecycle.disposed) return
        if (!lifecycle.legend) {
          lifecycle.opened = false
          void api.closeLspDocument(clientUri)
          return
        }
        scheduleSemanticRefresh(lifecycle, api, clientUri, setSnapshot)
      } catch {
        if (lifecycle.opened) {
          lifecycle.opened = false
          void api.closeLspDocument(clientUri)
        }
      }
    })()

    return () => {
      lifecycle.disposed = true
      if (lifecycle.frame !== null) {
        window.cancelAnimationFrame(lifecycle.frame)
        lifecycle.frame = null
      }
      if (lifecycle.opened) {
        lifecycle.opened = false
        void api.closeLspDocument(clientUri)
      }
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null
    }
    // Content is intentionally synchronized by the following effect. Putting
    // it here would turn every delta into close+open and forfeit stable LSP
    // document identity.
  }, [active, clientUri, normalizedLanguage, workspaceRoot])

  useEffect(() => {
    const lifecycle = lifecycleRef.current
    if (!active || !lifecycle || lifecycle.disposed) return
    lifecycle.latestContent = content
    scheduleSemanticRefresh(
      lifecycle,
      window.api as SemanticApi,
      clientUri,
      setSnapshot,
    )
  }, [active, clientUri, content])

  // Never apply ranges calculated for an older prefix to the newest text. The
  // single-flight loop discards stale responses; this equality also protects
  // the interval before its dirty replay publishes the newest snapshot.
  return snapshot?.content === content ? snapshot.lines : null
}

/**
 * Overlay semantic token classes onto trusted lexical-highlight HTML.
 *
 * highlight.js already escaped the source and owns keyword/string/comment
 * color. Wrapping only the ranges supplied by LSP means identifiers upgrade to
 * semantic color without downgrading all the lexical spans around them. The
 * input is never arbitrary provider HTML: callers pass `escapeHtml` or hljs
 * output exclusively.
 */
export function decorateLexicalHtml(
  lexicalHtml: string,
  ranges: SemanticTokenRange[] | null | undefined,
): string {
  if (!ranges || ranges.length === 0 || typeof document === 'undefined') {
    return lexicalHtml
  }

  const template = document.createElement('template')
  template.innerHTML = lexicalHtml
  let sourceOffset = 0

  const visit = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) {
        visit(node)
        continue
      }
      const text = node.textContent ?? ''
      const nodeStart = sourceOffset
      const nodeEnd = nodeStart + text.length
      sourceOffset = nodeEnd
      const overlaps = ranges.filter(
        range => range.start < nodeEnd && range.start + range.length > nodeStart,
      )
      if (overlaps.length === 0) continue

      const fragment = document.createDocumentFragment()
      let cursor = 0
      for (const range of overlaps) {
        const start = Math.max(cursor, range.start - nodeStart, 0)
        const end = Math.min(text.length, range.start + range.length - nodeStart)
        if (end <= start) continue
        if (start > cursor) fragment.append(text.slice(cursor, start))
        const span = document.createElement('span')
        span.className = range.className
        span.dataset.lspToken = range.tokenType
        span.textContent = text.slice(start, end)
        fragment.append(span)
        cursor = end
      }
      if (cursor < text.length) fragment.append(text.slice(cursor))
      node.replaceWith(fragment)
    }
  }
  visit(template.content)
  return template.innerHTML
}

export const SemanticTokenText = memo(function SemanticTokenText({
  text,
  lexicalHtml,
  ranges,
  className,
}: {
  text: string
  lexicalHtml: string
  ranges?: SemanticTokenRange[] | null
  className?: string
}) {
  const html = useMemo(
    () => decorateLexicalHtml(lexicalHtml, ranges),
    [lexicalHtml, ranges],
  )
  return (
    <span
      className={className}
      data-semantic-token-text={ranges && ranges.length > 0 ? 'lsp' : 'lexical'}
      // Empty diff rows need layout height but should not become the literal
      // word "undefined" if a malformed token response omitted a source line.
      dangerouslySetInnerHTML={{ __html: text === '' && html === '' ? '\u200b' : html }}
    />
  )
})
