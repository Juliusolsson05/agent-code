import { useMemo } from 'react'

import {
  buildAgentStatusModel,
  type AgentStatusModel,
} from '@renderer/features/agent-status/model/agentStatusModel'
import {
  errorFields,
  identityFields,
  mcpFields,
  placementFields,
  relationshipFields,
  runtimeFields,
  type AgentStatusField,
} from '@renderer/features/agent-status/model/formatAgentStatus'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  sessionId: string
  workspace: Workspace
  onClose: () => void
}

export function AgentStatusPanel({ sessionId, workspace, onClose }: Props) {
  const runtime = workspace.getRuntime(sessionId)
  const model = useMemo(
    () => buildAgentStatusModel(workspace.state, runtime, sessionId),
    [runtime, sessionId, workspace.state],
  )

  return (
    <aside className="
      h-full w-[390px] flex-shrink-0
      border-l border-border bg-surface
      flex flex-col overflow-hidden
      text-[11px]
    ">
      <div className="
        flex items-center justify-between gap-3
        px-3 py-2 border-b border-border
        select-none flex-shrink-0
      ">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
            Agent Status
          </div>
          <div className="truncate text-ink font-medium">
            {model ? model.title : 'No focused agent'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {model ? (
            <span className="
              border border-border bg-surface-hi px-1.5 py-0.5
              text-[10px] font-code uppercase text-ink-dim
            ">
              {model.kind}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink text-[16px] leading-none"
            aria-label="Close Agent Status"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {model ? <AgentStatusContent model={model} /> : <EmptyState />}
      </div>
    </aside>
  )
}

function AgentStatusContent({ model }: { model: AgentStatusModel }) {
  const errors = errorFields(model)
  return (
    <div className="flex flex-col gap-3">
      {/*
        WHY this panel is intentionally made of short, curated sections:
        Agent Code already has raw Debug/Feed/Proxy/HTML panels for large
        runtime payloads. This command is an operator-facing "what is this
        focused agent?" inspector, so adding JSON dumps or transcript tails
        here would make the fast path harder to scan and duplicate the debug
        surfaces that already exist for deep diagnosis.
      */}
      <Section title="Identity" fields={identityFields(model)} />
      <Section title="Runtime" fields={runtimeFields(model)} />
      {errors.length > 0 ? <Section title="Errors" fields={errors} /> : null}
      <Section title="Placement" fields={placementFields(model)} />
      <Section title="Relationships" fields={relationshipFields(model)} />
      <Section title="MCP" fields={mcpFields(model)} />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-border bg-bg px-3 py-3 text-muted">
      Focus a Claude or Codex agent to inspect its status.
    </div>
  )
}

function Section({ title, fields }: { title: string; fields: AgentStatusField[] }) {
  return (
    <section className="border border-border bg-bg">
      <div className="
        border-b border-border px-2 py-1
        text-[10px] uppercase tracking-[0.14em] text-muted
      ">
        {title}
      </div>
      <div className="divide-y divide-border/70">
        {fields.map(field => (
          <FieldRow key={`${field.label}:${field.value}`} field={field} />
        ))}
      </div>
    </section>
  )
}

function FieldRow({ field }: { field: AgentStatusField }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 px-2 py-1.5">
      <div className="text-muted">{field.label}</div>
      <div className={`min-w-0 break-words font-code ${toneClass(field.tone)}`}>
        {field.value}
      </div>
    </div>
  )
}

function toneClass(tone: AgentStatusField['tone']): string {
  if (tone === 'good') return 'text-green-400'
  if (tone === 'warn') return 'text-yellow-300'
  if (tone === 'bad') return 'text-red-400'
  return 'text-ink'
}
