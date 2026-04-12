// TextProse — memo'd ReactMarkdown wrapper for completed JSONL entries.
//
// The single biggest perf win in the feed: markdown parsing is the
// expensive part, and by memoing on the text string we skip the unified
// pipeline entirely for every row that didn't change.

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import { COMPLETED_REMARK } from './plugins'

// MARKDOWN_COMPONENTS is provider-specific (it depends on CodeBlock and
// CodeRenderContext). Callers pass it in so both providers can supply
// their own code renderer while sharing the text prose wrapper.
type Props = {
  text: string
  components?: import('react-markdown').Options['components']
}

export const TextProse = memo(function TextProse({ text, components }: Props) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={COMPLETED_REMARK}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
