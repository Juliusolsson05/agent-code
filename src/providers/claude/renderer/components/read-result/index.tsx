import { useContext, useState } from 'react'

import {
  stripClaudeReadGutter,
  type ClaudeReadResultModel,
} from '@providers/claude/renderer/adapters/readSearch'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { formatToolFilePath } from '@shared/paths/displayPath'

export function ClaudeReadResultRow({ model }: { model: ClaudeReadResultModel }) {
  const [open, setOpen] = useState(false)
  const { workspaceRoot } = useContext(CodeRenderContext)
  const displayPath = formatToolFilePath(model.path, workspaceRoot)
  const count = model.lineCountTruncated ? `≥${model.lineCount}` : String(model.lineCount)
  const noun = model.lineCount === 1 && !model.lineCountTruncated ? 'line' : 'lines'

  return (
    <MarkerRow marker="⎿" tone="muted">
      {/* Closing must unmount CodeBlock. Restored sessions can contain hundreds
          of reads; remembering every historical expansion would turn user
          interaction history into permanent Monaco/model/listener ownership. */}
      <details
        className="text-[12px] leading-[1.55] text-ink-dim"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none">
          Read <span className="text-ink font-semibold">{count}</span> {noun} from{' '}
          <span className="font-code" title={model.path}>
            {displayPath}
          </span>
        </summary>
        {open ? (
          <div className="mt-2">
            <CodeBlock
              code={model.content}
              path={model.path}
              workspaceRoot={workspaceRoot}
              codeId={`claude-read:${model.operationId}`}
              engine="monaco"
              allowAutoDetect
              transformPage={stripClaudeReadGutter}
            />
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}
