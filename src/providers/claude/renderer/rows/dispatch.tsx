import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
// Provider-internal imports reach component directories directly. Phase 9
// removed the old ClaudeRows feed barrel after live semantic dispatch moved
// behind the registry capability; reintroducing that barrel would reopen a
// shared-feed → provider interpretation edge.
import { EditRow } from '@providers/claude/renderer/components/edit'
import { ClaudeAgentRow } from '@providers/claude/renderer/components/agent'
import { MultiEditRow } from '@providers/claude/renderer/components/multi-edit'
import { ClaudeReadRow } from '@providers/claude/renderer/components/read'
import { ClaudeReadResultRow } from '@providers/claude/renderer/components/read-result'
import { ClaudeToolSearchRow } from '@providers/claude/renderer/components/tool-search'
import { ClaudeToolSearchResultRow } from '@providers/claude/renderer/components/tool-search-result'
import { ClaudeWebFetchRow } from '@providers/claude/renderer/components/web-fetch'
import { ClaudeWebFetchResultRow } from '@providers/claude/renderer/components/web-fetch-result'
import { ClaudeWebSearchRow } from '@providers/claude/renderer/components/web-search'
import { ClaudeWebSearchResultRow } from '@providers/claude/renderer/components/web-search-result'
import { WriteRow } from '@providers/claude/renderer/components/write'
import {
  fromClaudeAgentResult,
  fromClaudeAgentUse,
} from '@providers/claude/renderer/adapters/collaboration'
import {
  claudeBashConclusion,
  claudeBashResultText,
  fromClaudeBashBlock,
  fromClaudeBashCodeEdit,
} from '@providers/claude/renderer/adapters/command'
import {
  fromClaudeReadResult,
  fromClaudeReadUse,
  fromClaudeToolSearchResult,
  fromClaudeToolSearchUse,
} from '@providers/claude/renderer/adapters/readSearch'
import {
  fromClaudeWebFetchResult,
  fromClaudeWebFetchUse,
  fromClaudeWebSearchResult,
  fromClaudeWebSearchUse,
} from '@providers/claude/renderer/adapters/web'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { OutputWell } from '@renderer/lib/text/OutputWell'
import { AgentCodeOrchestrationView } from '@providers/shared/renderer/protocols/agent-code-orchestration/AgentCodeOrchestrationView'
import { fromAgentCodeOrchestrationResult } from '@providers/shared/renderer/protocols/agent-code-orchestration/model'
import { fromClaudeAgentCodeOrchestrationUse } from '@providers/claude/renderer/adapters/agentCodeOrchestration'
import { fromClaudeAgentCodeWorkspaceUse } from '@providers/claude/renderer/adapters/agentCodeWorkspace'
import { AgentCodeWorkspaceView } from '@providers/shared/renderer/protocols/agent-code-workspace/AgentCodeWorkspaceView'
import { fromAgentCodeWorkspaceResult } from '@providers/shared/renderer/protocols/agent-code-workspace/model'
import {
  fromClaudeTaskActivityResult,
  fromClaudeTaskActivityUse,
} from '@providers/claude/renderer/adapters/tasks'
import { ClaudeTaskActivityRow } from '@providers/claude/renderer/components/task-activity'
import {
  fromClaudeQuestionResult,
  fromClaudeQuestionUse,
} from '@providers/claude/renderer/adapters/questions'
import {
  ClaudeAnsweredQuestionRow,
  ClaudeLiveQuestionRow,
} from '@providers/claude/renderer/components/ask-user-question'
import { fromClaudeAgentCodeWorkflowUse } from '@providers/claude/renderer/adapters/agentCodeWorkflow'
import { AgentCodeWorkflowView } from '@providers/shared/renderer/protocols/agent-code-workflow/AgentCodeWorkflowView'
import { fromAgentCodeWorkflowResult } from '@providers/shared/renderer/protocols/agent-code-workflow/model'
import { GenericLiveResult } from '@providers/shared/renderer/rows/GenericLiveResult'

export function renderClaudeToolUse(
  block: ToolUseBlock,
  context: { live?: boolean; streaming?: boolean; result?: ToolResultBlock | null } = {},
): ReactNode | undefined {
  const failed = context.result?.is_error === true
  const running = context.live === true && !context.streaming && context.result == null
  const errorSummary = failed ? firstResultLine(context.result) : undefined
  const agentCodeOrchestration = fromClaudeAgentCodeOrchestrationUse(block)
  if (agentCodeOrchestration) {
    return <AgentCodeOrchestrationView model={agentCodeOrchestration} />
  }
  const agentCodeWorkspace = fromClaudeAgentCodeWorkspaceUse(block)
  if (agentCodeWorkspace) {
    return <AgentCodeWorkspaceView model={agentCodeWorkspace} />
  }
  const agentCodeWorkflow = fromClaudeAgentCodeWorkflowUse(block)
  if (agentCodeWorkflow) {
    return <AgentCodeWorkflowView model={agentCodeWorkflow} />
  }
  const taskActivity = fromClaudeTaskActivityUse(block)
  if (taskActivity) {
    return <ClaudeTaskActivityRow model={taskActivity} />
  }
  const question = fromClaudeQuestionUse(block)
  if (question) {
    return context.live === true && context.result == null
      ? <ClaudeLiveQuestionRow model={question} />
      : <ClaudeAnsweredQuestionRow model={question} result={context.result ?? null} />
  }
  // WHY this dispatch lives with the provider rows: these names are Claude Code
  // transcript vocabulary, not feed vocabulary. Keeping the table beside the
  // row components makes adding/removing a Claude tool a provider-local change
  // and lets the shared feed keep one generic fallback for unknown tools.
  switch (block.name) {
    case 'Agent': {
      const model = fromClaudeAgentUse(block)
      return model ? <ClaudeAgentRow model={model} /> : undefined
    }
    case 'Bash': {
      // Phase 6 cutover: non-git Bash renders through the command protocol
      // (the git-intent subset is intercepted BEFORE dispatch by Block.tsx's
      // widget, so this case only ever sees plain commands or
      // customRendering-off sessions). Whitespace-only input falls through
      // to the generic row, preserved behavior.
      //
      // A quoted-delimiter cat-heredoc is a FILE WRITE wearing a command's
      // clothes — route it into the code-edit card so the written content is
      // visible (product-owner verdict 2026-07-17). The extractor's strict
      // contract means this claims only the honest cases; everything else
      // falls through to the command card unchanged.
      const write = fromClaudeBashCodeEdit(block, {
        streaming: context.streaming,
        running,
        failed,
        errorSummary,
      })
      if (write) return <CodeEditView model={write} />
      const model = fromClaudeBashBlock(block, {
        streaming: context.streaming,
        running,
        failed,
        errorSummary,
      })
      return model ? <CommandView model={model} /> : undefined
    }
    case 'Edit':
      return <EditRow block={block} streaming={context.streaming} running={running} failed={failed} errorSummary={errorSummary} />
    case 'MultiEdit':
      return <MultiEditRow block={block} />
    case 'Read': {
      const model = fromClaudeReadUse(block)
      return model ? <ClaudeReadRow model={model} /> : undefined
    }
    case 'ToolSearch': {
      const model = fromClaudeToolSearchUse(block)
      return model ? <ClaudeToolSearchRow model={model} /> : undefined
    }
    case 'WebFetch': {
      const model = fromClaudeWebFetchUse(block)
      return model ? <ClaudeWebFetchRow model={model} /> : undefined
    }
    case 'WebSearch': {
      const model = fromClaudeWebSearchUse(block)
      return model ? <ClaudeWebSearchRow model={model} /> : undefined
    }
    case 'Write':
      return <WriteRow block={block} streaming={context.streaming} running={running} failed={failed} errorSummary={errorSummary} />
    default:
      return undefined
  }
}

function firstResultLine(result: ToolResultBlock | null | undefined): string | undefined {
  if (!result) return undefined
  const content = result.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(item => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '').join('\n')
      : ''
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).slice(0, 200) || 'tool failed'
}

export function renderClaudeToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  // Phase 6: Bash output gets the shared grammar — ANSI-aware OutputWell
  // (head+tail preview so the final error/summary always survives) plus a
  // formatter-registry conclusion line (test totals, JSON size) rendered
  // ABOVE the raw evidence, terminal-only by construction on the committed
  // plane. Everything else keeps the generic result row.
  const source = context.sourceTool
  const agentCodeOrchestration = source
    ? fromClaudeAgentCodeOrchestrationUse(source)
    : null
  if (agentCodeOrchestration) {
    // The provider-owned invocation card reads its paired result through the
    // feed index and paints both the lifecycle summary and raw protocol
    // disclosure. Suppress only after the owned result parser proves the
    // operation contract; drift/malformed typed content remains visible via
    // the generic result row.
    return fromAgentCodeOrchestrationResult(block, agentCodeOrchestration)
      ? null
      : undefined
  }
  const agentCodeWorkspace = source
    ? fromClaudeAgentCodeWorkspaceUse(source)
    : null
  if (agentCodeWorkspace) {
    return fromAgentCodeWorkspaceResult(block, agentCodeWorkspace)
      ? null
      : undefined
  }
  const agentCodeWorkflow = source
    ? fromClaudeAgentCodeWorkflowUse(source)
    : null
  if (agentCodeWorkflow) {
    return fromAgentCodeWorkflowResult(block, agentCodeWorkflow)
      ? null
      : undefined
  }
  const taskActivity = source ? fromClaudeTaskActivityUse(source) : null
  if (taskActivity) {
    return fromClaudeTaskActivityResult(block, taskActivity)
      ? null
      : undefined
  }
  const question = source ? fromClaudeQuestionUse(source) : null
  if (question) {
    return fromClaudeQuestionResult(block, question) !== null
      ? null
      : undefined
  }
  if (source?.name === 'Agent') {
    // A validated Agent result is rendered inside the provider-owned spawn
    // card, which already has the paired result through ToolResultIndexContext.
    // Returning null records an explicit absorption receipt; malformed/error
    // variants decline to the visible generic result instead.
    return fromClaudeAgentResult(block, source) ? null : undefined
  }
  if (source?.name === 'Bash') {
    const text = claudeBashResultText(block)
    if (!text && block.is_error !== true) {
      // Silent success stays visible as evidence (#524 lesson: an empty
      // stdout must not erase that the command ran) — the command card
      // above already shows it; render a quiet no-output marker.
      return <OutputWell text="" isError={false} />
    }
    const input = (source.input ?? {}) as Record<string, unknown>
    const command = typeof input.command === 'string' ? input.command : ''
    const conclusion = claudeBashConclusion(block, command)
    return (
      <div className="flex flex-col gap-0.5">
        {conclusion ? (
          <div className="text-ink-dim text-[12px] pl-6">{conclusion}</div>
        ) : null}
        <GenericLiveResult
          source={text}
          isError={block.is_error === true}
          textFallback="output-well"
        />
      </div>
    )
  }
  if (source?.name === 'Read') {
    const model = fromClaudeReadResult(block, source)
    // A malformed/error result deliberately declines to Block.tsx's visible
    // generic fallback. The tool-use card above can still be specialized,
    // while unsupported result evidence remains verbatim instead of being
    // forced through a parser that did not prove its grammar.
    return model ? <ClaudeReadResultRow model={model} /> : undefined
  }
  if (source?.name === 'ToolSearch') {
    const model = fromClaudeToolSearchResult(block, source)
    return model ? <ClaudeToolSearchResultRow model={model} /> : undefined
  }
  if (source?.name === 'WebFetch') {
    const model = fromClaudeWebFetchResult(block, source)
    return model ? <ClaudeWebFetchResultRow model={model} /> : undefined
  }
  if (source?.name === 'WebSearch') {
    const model = fromClaudeWebSearchResult(block, source)
    return model ? <ClaudeWebSearchResultRow model={model} /> : undefined
  }
  return undefined
}
