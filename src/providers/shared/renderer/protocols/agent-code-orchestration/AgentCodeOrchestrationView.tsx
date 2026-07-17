import { useContext, useState } from 'react'

import { asRecord } from '@shared/lib/asRecord'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ToolResultIndexContext } from '@renderer/features/feed/context'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import {
  fromAgentCodeOrchestrationResult,
  type AgentCodeOrchestrationOperation,
  type AgentCodeOrchestrationResultModel,
  type AgentCodeOrchestrationUseModel,
} from '@providers/shared/renderer/protocols/agent-code-orchestration/model'

const MAX_AGENT_ROWS = 50
const MAX_OUTPUT_ROWS = 20
const MAX_MESSAGE_ROWS = 20
const LABEL_MAX_CHARS = 240

const OPERATION_LABELS: Record<AgentCodeOrchestrationOperation, string> = {
  'create-agent': 'Create agent',
  'send-prompt': 'Send agent prompt',
  'list-agents': 'List agents',
  'read-agent': 'Read agent output',
  'read-run-outputs': 'Read run outputs',
  'wait-agents': 'Wait for agents',
  'close-agent': 'Close agent',
  'close-run': 'Close run',
}

function boundedLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const page = boundedTextPage(value, 0, LABEL_MAX_CHARS, 2)
  return page.hasNext ? `${page.text}…` : page.text
}

function inputSubject(model: AgentCodeOrchestrationUseModel): string | null {
  const input = model.input
  switch (model.operation) {
    case 'create-agent':
      return boundedLabel(input.title) ?? boundedLabel(input.role) ?? boundedLabel(input.kind)
    case 'send-prompt':
    case 'read-agent':
    case 'close-agent':
      return boundedLabel(input.sessionId)
    case 'list-agents':
    case 'read-run-outputs':
    case 'close-run':
      return boundedLabel(input.runId)
    case 'wait-agents': {
      const run = boundedLabel(input.runId)
      if (run) return run
      return Array.isArray(input.sessionIds)
        ? `${input.sessionIds.length} selected agent${input.sessionIds.length === 1 ? '' : 's'}`
        : null
    }
  }
}

function stateTone(state: unknown): string {
  if (state === 'failed' || state === 'interrupted') return 'text-danger'
  if (state === 'completed' || state === 'closed') return 'text-success'
  return 'text-ink-dim'
}

function AgentRecordLine({ value }: { value: unknown }) {
  const agent = asRecord(value)
  if (!agent) return null
  const title = boundedLabel(agent.title) ?? boundedLabel(agent.orchestrationRole)
  const sessionId = boundedLabel(agent.sessionId) ?? 'unknown session'
  const kind = boundedLabel(agent.kind)
  const state = boundedLabel(agent.lifecycleState) ?? boundedLabel(agent.statusSummary) ?? 'unknown'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[11px] leading-[1.55]">
      <div className="min-w-0">
        <span className="text-ink">{title ?? kind ?? 'agent'}</span>
        <span className="ml-2 font-code text-ink-dim break-all" title={sessionId}>
          {sessionId}
        </span>
      </div>
      <span className={`${stateTone(agent.lifecycleState)} whitespace-nowrap`}>{state}</span>
    </div>
  )
}

function AgentList({ values }: { values: readonly unknown[] }) {
  const admitted = values.slice(0, MAX_AGENT_ROWS)
  return (
    <div className="space-y-0.5">
      {admitted.map((value, index) => <AgentRecordLine key={index} value={value} />)}
      {values.length > admitted.length ? (
        <div className="text-muted text-[11px]">
          {values.length - admitted.length} more agents omitted from this preview
        </div>
      ) : null}
    </div>
  )
}

function AgentOutputDisclosure({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const output = asRecord(value)
  const agent = asRecord(output?.agent)
  if (!output || !agent) return null
  const messages = Array.isArray(output.messages) ? output.messages : []
  const title = boundedLabel(agent.title) ?? boundedLabel(agent.orchestrationRole)
    ?? boundedLabel(agent.kind) ?? 'agent'
  const state = boundedLabel(agent.lifecycleState) ?? 'unknown'
  return (
    <details
      className="rounded border border-border/60 px-2 py-1"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none text-[11px] text-ink-dim">
        {title} · {state} · {messages.length} message{messages.length === 1 ? '' : 's'}
        {output.truncated === true ? ' · truncated' : ''}
      </summary>
      {/* WHY message bodies mount only for the one output the user opens:
          read-run/wait can legally return many children, each with large but
          individually bounded text. A parent disclosure alone would still
          instantiate every page viewer at once and turn a protocol cap into a
          DOM multiplier. */}
      {open ? (
        <div className="mt-2 space-y-2">
          {messages.slice(0, MAX_MESSAGE_ROWS).map((message, index) => {
            const record = asRecord(message)
            if (!record || typeof record.text !== 'string') return null
            return (
              <section key={index} aria-label={`Agent ${record.role === 'user' ? 'user' : 'assistant'} message`}>
                <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5">
                  {record.role === 'user' ? 'User' : 'Assistant'}
                  {record.truncated === true ? ' · truncated' : ''}
                </div>
                <PagedTextViewer source={record.text} />
              </section>
            )
          })}
          {messages.length > MAX_MESSAGE_ROWS ? (
            <div className="text-muted text-[11px]">
              {messages.length - MAX_MESSAGE_ROWS} more messages omitted from this preview
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

function InvocationDisclosure({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const [exactOpen, setExactOpen] = useState(false)
  return (
    <details
      className="text-[11px] text-muted"
      onToggle={event => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
        if (!nextOpen) setExactOpen(false)
      }}
    >
      <summary className="cursor-pointer select-none">Invocation parameters</summary>
      {/* WHY projection waits for this inner disclosure, not merely the outer
          card: prompts and session-id arrays can be large, and a user opening
          the useful agent summary should not implicitly stringify/highlight
          the entire invocation. */}
      {open ? (() => {
        const json = boundedJsonPreview(input)
        if (!json) return null
        return (
          <div className="mt-1 space-y-2">
            <CodeBlock code={json} language="json" />
            <details
              onToggle={event => setExactOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer select-none">View exact paged parameters</summary>
              {/* WHY full serialization requires a second explicit click:
                  prompts can be much larger than the useful JSON preview.
                  The first disclosure must stay bounded; the second is the
                  forensic escape hatch that guarantees provider-owned cards
                  do not become evidence sinks. Closing releases the string
                  and page DOM again. */}
              {exactOpen ? (() => {
                try {
                  return <PagedTextViewer source={JSON.stringify(input, null, 2)} />
                } catch {
                  return <span>Exact parameters are unavailable for this non-serializable value.</span>
                }
              })() : null}
            </details>
          </div>
        )
      })() : null}
    </details>
  )
}

function resultSummary(result: AgentCodeOrchestrationResultModel): string {
  const value = result.value
  if (value.ok === false) {
    return boundedLabel(value.message) ?? boundedLabel(value.error) ?? 'failed'
  }
  switch (result.operation) {
    case 'create-agent': {
      const agent = asRecord(value.agent)
      return boundedLabel(agent?.lifecycleState) ?? 'created'
    }
    case 'send-prompt':
      return 'sent'
    case 'list-agents': {
      const count = Array.isArray(value.agents) ? value.agents.length : 0
      return `${count} agent${count === 1 ? '' : 's'}`
    }
    case 'read-agent': {
      const output = asRecord(value.output)
      const messages = Array.isArray(output?.messages) ? output.messages.length : 0
      return `${messages} message${messages === 1 ? '' : 's'}`
    }
    case 'read-run-outputs': {
      const count = Array.isArray(value.outputs) ? value.outputs.length : 0
      return `${count} output${count === 1 ? '' : 's'}${value.truncated === true ? ' · truncated' : ''}`
    }
    case 'wait-agents': {
      const count = Array.isArray(value.agents) ? value.agents.length : 0
      return `${value.done === true ? 'done' : 'timed out'} · ${count} agent${count === 1 ? '' : 's'}`
    }
    case 'close-agent':
    case 'close-run': {
      const count = Array.isArray(value.closedSessionIds) ? value.closedSessionIds.length : 0
      return `${count} closed`
    }
  }
}

function RichResult({ result }: { result: AgentCodeOrchestrationResultModel }) {
  const value = result.value
  if (value.ok === false) {
    return (
      <div className="text-danger text-[12px]">
        {boundedLabel(value.message) ?? boundedLabel(value.error) ?? 'Agent Code orchestration failed'}
      </div>
    )
  }
  if (result.operation === 'create-agent') return <AgentRecordLine value={value.agent} />
  if (result.operation === 'list-agents') {
    const agents = Array.isArray(value.agents) ? value.agents : []
    return <AgentList values={agents} />
  }
  if (result.operation === 'read-agent') {
    return <AgentOutputDisclosure value={value.output} />
  }
  if (result.operation === 'read-run-outputs' || result.operation === 'wait-agents') {
    const outputs = Array.isArray(value.outputs) ? value.outputs : []
    const agents = result.operation === 'wait-agents' && Array.isArray(value.agents)
      ? value.agents
      : []
    return (
      <div className="space-y-1">
        {agents.length > 0 ? <AgentList values={agents} /> : null}
        {outputs.slice(0, MAX_OUTPUT_ROWS).map((output, index) => (
          <AgentOutputDisclosure key={index} value={output} />
        ))}
        {outputs.length > MAX_OUTPUT_ROWS ? (
          <div className="text-muted text-[11px]">
            {outputs.length - MAX_OUTPUT_ROWS} more outputs omitted from this preview
          </div>
        ) : null}
      </div>
    )
  }
  return null
}

export function AgentCodeOrchestrationView({
  model,
}: {
  model: AgentCodeOrchestrationUseModel
}) {
  const [open, setOpen] = useState(false)
  const paired = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  const result = paired ? fromAgentCodeOrchestrationResult(paired, model) : null
  const subject = inputSubject(model)
  const status = result ? resultSummary(result) : paired ? 'unrecognized result' : 'running'
  const marker = result?.value.ok === false ? '✗' : result ? '✓' : paired ? '◌' : '◐'

  return (
    <MarkerRow marker={marker}>
      <details
        className="text-[12px]"
        onToggle={event => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none list-none">
          <span className="text-accent font-semibold">{OPERATION_LABELS[model.operation]}</span>
          <span className="ml-2 text-[10px] text-ink-dim border border-border rounded px-1 py-px">
            Agent Code MCP
          </span>
          {subject ? <span className="ml-2 text-ink-dim break-all">{subject}</span> : null}
          <span className={result?.value.ok === false ? 'ml-2 text-danger' : 'ml-2 text-muted'}>
            · {status}
          </span>
        </summary>
        {/* WHY both normalized presentation and raw protocol remain available:
            Agent Code owns this schema, so a rich lifecycle view is justified;
            it still evolves independently of this renderer. The structured
            disclosure makes additive fields visible immediately instead of
            turning a confident adapter into an evidence sink. */}
        {open ? (
          <div className="mt-2 ml-2 border-l border-border/60 pl-3 space-y-2">
            {result ? <RichResult result={result} /> : null}
            <InvocationDisclosure input={model.input} />
            {result ? (
              <details className="text-[11px] text-muted">
                <summary className="cursor-pointer select-none">Protocol result</summary>
                <div className="mt-1">
                  <JsonResultSlab
                    value={result.value}
                    isError={result.value.ok === false}
                    source={result.source}
                  />
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}
