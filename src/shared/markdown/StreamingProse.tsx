// StreamingProse — memo'd ReactMarkdown for screen-buffer streaming text.
//
// Same as TextProse but uses remark-breaks so hard newlines from the
// screen buffer survive as <br>. CC's screen re-renders fire at ~60Hz
// and the extracted text is usually identical between frames — memoing
// by text string makes those redundant frames free.

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import { STREAMING_REMARK } from './plugins'

type Props = {
  text: string
  components?: import('react-markdown').Options['components']
}

export const StreamingProse = memo(function StreamingProse({ text, components }: Props) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={STREAMING_REMARK}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
