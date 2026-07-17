import { useState } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'

/** Collapsed JSON disclosure that owns no projection/highlighter tree.
 *
 * WHY this tiny primitive exists: native `<details>` hides paint but React
 * still constructs its children. Tool/workflow inputs can be large, so every
 * collapsed card must gate both bounded projection and CodeBlock mounting on
 * actual open state; repeating the pattern produced four regressions in one
 * phase. */
export function LazyJsonDisclosure({
  label,
  value,
}: {
  label: string
  value: unknown
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="text-[11px] text-muted"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">{label}</summary>
      {open ? (
        <div className="mt-1">
          <CodeBlock
            code={boundedJsonPreview(value) ?? '(unavailable)'}
            language="json"
            highlight={false}
          />
        </div>
      ) : null}
    </details>
  )
}
