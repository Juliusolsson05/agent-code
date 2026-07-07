import type { ReactNode } from 'react'

import type { ToolResultBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'

/* ---------- opencode `read` result ---------- */
//
// opencode's read tool returns a tagged text document —
//   <path>/abs/file.ts</path> … <content>\n1: line\n…</content>
// — which the generic TruncatedOutputRow shows as literal tag soup (the
// 2026-07-06 "fuck ton of rendering to handle" bundle). Parse the two
// tags we need and present the content as a code slab keyed by the real
// path so language detection works.
//
// DELIBERATELY tolerant: any deviation from the expected shape returns
// undefined and the caller falls through to the generic row — a renderer
// that guesses wrong must degrade to verbatim text, never invent
// structure. (No committed fixture carries a full read result yet; shape
// sourced from the bundle's rendered HTML. Tighten with a fixture when
// one is captured.)

function resultText(block: ToolResultBlock): string | null {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find(b => asRecord(b)?.type === 'text')
    const text = asRecord(t)?.text
    return typeof text === 'string' ? text : null
  }
  return null
}

export function renderOpencodeReadResult(block: ToolResultBlock): ReactNode | undefined {
  const text = resultText(block)
  if (!text) return undefined
  const path = /<path>\s*([^<\n]+?)\s*<\/path>/.exec(text)?.[1] ?? null
  // GREEDY capture ([\s\S]*, no `?`) is deliberate: file bodies routinely
  // contain a literal "</content>" (docs, tests, this very renderer's own
  // source), and a non-greedy capture stops at the FIRST such string —
  // silently truncating the displayed file at the first inner tag. opencode
  // wraps the whole document in a single outer <content>…</content>, so the
  // real terminator is the LAST closing tag; greedy backtracks to exactly it.
  const body = /<content>\n?([\s\S]*)\n?<\/content>/.exec(text)?.[1] ?? null
  if (!path || body === null) return undefined

  // Strip the "N: " line-number gutter opencode prepends — CodeBlock has
  // its own gutter and doubled numbers read as corrupted output.
  const stripped = body
    .split('\n')
    .map(l => l.replace(/^\s*\d+:\s?/, ''))
    .join('\n')

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details className="text-[12px]">
        <summary className="cursor-pointer text-ink-dim select-none font-code break-all">
          {path}
        </summary>
        <div className="mt-1">
          <CodeBlock code={stripped} path={path} codeId={`oc-read:${block.tool_use_id ?? path}`} />
        </div>
      </details>
    </MarkerRow>
  )
}
