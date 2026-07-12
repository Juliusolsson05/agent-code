import { memo } from 'react'

import {
  lastClosedCodeFenceEnd,
  splitStreamingCodeFence,
} from '@renderer/features/feed/lib/helpers'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import { StreamingCodeBlock } from './StreamingCodeBlock'

// Streaming markdown without whole-message reparse.
//
// The old path fed the ENTIRE growing message through StreamingProse
// every delta. StreamingProse memoizes on the full text string, so the
// memo never hit while streaming — the whole unified pipeline
// (remark-parse → remark-gfm → remark-breaks → rehype-highlight) re-ran
// per token batch: O(len²) work over a long message. Worse, a message
// streaming its SECOND code fence re-parsed the first (now-closed)
// fence through markdown on every delta too, because
// splitStreamingCodeFence only splits at the LAST odd fence.
//
// Fix: split at the end of the last CLOSED fence.
//   - The `sealed` prefix string changes identity only when a fence
//     CLOSES (rare — a handful of times per message), so the memoized
//     StreamingProse over it is effectively parse-once.
//   - Only the `tail` (text since the last closed fence — bounded,
//     usually a paragraph or one growing code block) re-parses per
//     delta; an open fence in the tail streams through
//     StreamingCodeBlock (sealed-line highlight, no reparse at all).
//
// WHY the boundary is "last closed fence" and not "last completed
// paragraph": fences are the only markdown construct here whose parse
// cost is both heavy and REGION-STABLE — prose before a closed fence
// cannot be re-interpreted by later text (a fence is a hard block
// boundary in commonmark). Sealing at paragraph boundaries would be
// wrong: a later delta can turn a paragraph into a list continuation
// or setext heading. Sealing at closed fences is conservative and
// always safe.
//
// Fence detection intentionally mirrors splitStreamingCodeFence's
// conservative backtick-only heuristic (no ~~~ fences) so the two agree on
// what is "open". Both consume the same line-aware scanner in helpers.ts.

export function splitSealedPrefix(text: string): { sealed: string; tail: string } {
  const sealedEnd = lastClosedCodeFenceEnd(text)
  if (sealedEnd === 0) return { sealed: '', tail: text }
  return { sealed: text.slice(0, sealedEnd), tail: text.slice(sealedEnd) }
}

export const SegmentedMarkdown = memo(function SegmentedMarkdown({
  text,
  blockKey,
}: {
  text: string
  blockKey: string
}) {
  if (!text) return null
  const { sealed, tail } = splitSealedPrefix(text)
  const fence = tail ? splitStreamingCodeFence(tail) : null
  return (
    <div className="flex flex-col gap-2">
      {sealed ? <StreamingProse text={sealed} /> : null}
      {fence ? (
        <>
          {fence.prose ? <StreamingProse text={fence.prose} /> : null}
          <StreamingCodeBlock
            code={fence.code}
            language={fence.language}
            blockKey={`${blockKey}:fence`}
          />
        </>
      ) : tail ? (
        <StreamingProse text={tail} />
      ) : null}
    </div>
  )
})
