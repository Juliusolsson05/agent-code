import { useState } from 'react'

import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
import {
  GitOperationView,
  type GitOperationModel,
} from '@providers/shared/renderer/protocols/command/formatters/git'

export type CodexCommandGroupModel = {
  items: Array<{
    command: CommandRenderModel
    git: GitOperationModel | null
  }>
  exactOutput?: string
}

/** One Codex JavaScript cell can launch several real shell operations. Keep
 * those commands as sibling operation rows instead of flattening the script
 * into one syntax-highlighted headline or detaching its numbered output into
 * a generic JSON slab.
 *
 * WHY the exact grouped source is retained after child attribution: numbered
 * delimiters are presentation evidence, not an escaping protocol. A command
 * can legitimately print delimiter-looking text. The adapter admits only a
 * complete sequential frame, while this disclosure guarantees that even an
 * unlucky collision cannot hide or rewrite the original paired payload.
 */
export function CodexCommandGroupRow({ model }: { model: CodexCommandGroupModel }) {
  const [exactOpen, setExactOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      {model.items.map((item, index) => (
        <div key={`${index}:${item.command.command}`}>
          {item.git
            ? <GitOperationView model={item.git} />
            : <CommandView model={item.command} />}
        </div>
      ))}
      {model.exactOutput !== undefined ? (
        <details
          className="ml-5 text-[11px] text-muted"
          onToggle={event => setExactOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer hover:text-ink">
            view exact grouped output · {model.exactOutput.length.toLocaleString()} characters
          </summary>
          {exactOpen ? (
            <div className="mt-1">
              <PagedTextViewer source={model.exactOutput} />
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
