import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import { COMPLETED_REMARK, STREAMING_REMARK } from '@renderer/features/feed/lib/remark-plugins'

import { MARKDOWN_COMPONENTS } from '@renderer/features/feed/ui/markdown/MarkdownComponents'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import {
  collapsedTextPreview,
  exceedsInlineTextBudget,
} from '@renderer/lib/text/boundedText'

// Two prose renderers with the same visual surface but different
// remark plugin sets. TextProse is for committed JSONL assistant
// text (real markdown, standard paragraph/line rules). StreamingProse
// is for the live screen-buffer extract (ANSI-stripped plain text
// where each newline is a genuine line — `remark-breaks` added so
// those newlines render as <br>). See ../lib/remark-plugins.ts for
// the full rationale on why these two sets differ.

/* ---------- Text prose ---------- */

function OversizedProseFallback({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = collapsedTextPreview(text)

  // WHY oversized Markdown deliberately becomes paged plain text instead of
  // paged Markdown: arbitrary page boundaries can split a fence, list, table,
  // or HTML node and make the parser reinterpret the remainder. More
  // importantly, the fat freeze investigation found an 87-second renderer
  // task caused by admitting complete durable content into synchronous parser
  // and DOM work. A raw bounded page is honest, copyable, and gives a strict
  // upper bound; the durable transcript remains the source of the full value.
  return (
    <div className="min-w-0">
      {open ? (
        <PagedTextViewer source={text} />
      ) : (
        <pre className="font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0 text-ink-dim max-h-[180px] overflow-auto">
          {preview.text}
        </pre>
      )}
      <button
        type="button"
        className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
        onClick={() => setOpen(current => !current)}
      >
        {open ? 'collapse large message' : `view paged message · ${text.length.toLocaleString()} characters`}
      </button>
    </div>
  )
}

// Memoized: `text` is a plain string, so shallow compare is exact
// equality. This is the single biggest win in the file — markdown
// parsing is the expensive part, and by memoing on the text string we
// skip the unified pipeline entirely for every row that didn't change.
export const TextProse = memo(function TextProse({ text }: { text: string }) {
  if (!text) return null
  if (exceedsInlineTextBudget(text)) return <OversizedProseFallback text={text} />
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={COMPLETED_REMARK}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * Same visual surface as TextProse, but uses the streaming plugin set
 * (remark-breaks added) so hard newlines from the screen buffer survive
 * as <br> in the rendered output. See the comment on STREAMING_REMARK
 * in ../lib/remark-plugins.ts for the full reasoning.
 *
 * Memoized by text string too: CC's screen re-renders fire at ~60Hz
 * and the extracted assistant text is usually identical between frames
 * (CC is redrawing chrome, not changing content). Memoing here turns
 * those redundant frames into free ones.
 */
export const StreamingProse = memo(function StreamingProse({
  text,
}: {
  text: string
}) {
  if (!text) return null
  if (exceedsInlineTextBudget(text)) return <OversizedProseFallback text={text} />
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={STREAMING_REMARK}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
