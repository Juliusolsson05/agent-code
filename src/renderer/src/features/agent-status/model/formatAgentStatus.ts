import type { AgentStatusModel } from '@renderer/features/agent-status/model/agentStatusModel'

export type AgentStatusField = {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}

export function formatProviderSession(model: AgentStatusModel): string {
  return model.providerSessionId ? `present · ${shortId(model.providerSessionId)}` : 'missing'
}

export function formatPlacement(model: AgentStatusModel): string {
  const base =
    model.placement.bucket === 'pinned-dispatch'
      ? `Pinned Dispatch · ${formatPhysicalPlacement(model.placement.physical)}`
      : model.placement.bucket === 'detached-dispatch'
        ? 'Detached Dispatch'
        : model.placement.bucket === 'grid'
          ? 'Grid'
          : 'unknown'
  return model.placement.dispatchLabel
    ? `${base} · ${model.placement.dispatchLabel}`
    : base
}

export function identityFields(model: AgentStatusModel): AgentStatusField[] {
  return [
    { label: 'Session', value: shortId(model.sessionId) },
    { label: 'Kind', value: model.kind },
    { label: 'Provider session', value: formatProviderSession(model) },
    { label: 'Cwd', value: model.cwd },
  ]
}

export function runtimeFields(model: AgentStatusModel): AgentStatusField[] {
  return [
    {
      label: 'Session',
      value: `${model.runtime.sessionStatus} · ${model.runtime.sessionStatusSource}`,
      tone: statusTone(model.runtime.sessionStatus),
    },
    {
      label: 'Process',
      value: model.runtime.processStatus,
      tone: processTone(model.runtime.processStatus),
    },
    {
      label: 'Transcript',
      value: model.runtime.transcriptStatus,
      tone: transcriptTone(model.runtime.transcriptStatus),
    },
    {
      label: 'Activity',
      value: activityText(model),
    },
  ]
}

export function placementFields(model: AgentStatusModel): AgentStatusField[] {
  return [
    { label: 'Placement', value: formatPlacement(model) },
    { label: 'Owner tab', value: formatOwnerTab(model) },
    { label: 'Active tab', value: model.placement.activeTab ? 'yes' : 'no' },
    { label: 'Focused', value: model.placement.focused ? 'yes' : 'no' },
  ]
}

export function relationshipFields(model: AgentStatusModel): AgentStatusField[] {
  const fields: AgentStatusField[] = []
  if (model.relationships.linkedParentId) {
    fields.push({ label: 'Linked parent', value: shortId(model.relationships.linkedParentId) })
  }
  if (model.relationships.orchestrationParentId) {
    fields.push({
      label: 'Orch parent',
      value: shortId(model.relationships.orchestrationParentId),
    })
  }
  if (model.relationships.orchestrationRootId) {
    fields.push({
      label: 'Orch root',
      value: shortId(model.relationships.orchestrationRootId),
    })
  }
  if (model.relationships.orchestrationRunId) {
    fields.push({ label: 'Orch run', value: model.relationships.orchestrationRunId })
  }
  if (model.relationships.orchestrationRole) {
    fields.push({ label: 'Orch role', value: model.relationships.orchestrationRole })
  }
  return fields.length > 0 ? fields : [{ label: 'Relationships', value: 'none' }]
}

export function mcpFields(model: AgentStatusModel): AgentStatusField[] {
  return [
    {
      label: 'Built-in MCP',
      value: model.mcp.builtInDomains.length > 0
        ? model.mcp.builtInDomains.join(', ')
        : 'none',
    },
  ]
}

export function errorFields(model: AgentStatusModel): AgentStatusField[] {
  const fields: AgentStatusField[] = []
  if (model.runtime.processError) {
    fields.push({ label: 'Process error', value: model.runtime.processError, tone: 'bad' })
  }
  if (model.runtime.transcriptError) {
    fields.push({ label: 'Transcript error', value: model.runtime.transcriptError, tone: 'bad' })
  }
  return fields
}

export function shortId(value: string, length = 12): string {
  return value.length <= length ? value : value.slice(0, length)
}

function activityText(model: AgentStatusModel): string {
  if (model.runtime.pendingCompaction) return `compaction · ${model.runtime.pendingCompaction}`
  if (model.runtime.activityStatus) return model.runtime.activityStatus
  if (model.runtime.streamPhase !== 'idle') return model.runtime.streamPhase
  return 'idle'
}

function formatOwnerTab(model: AgentStatusModel): string {
  if (!model.placement.tabTitle) return 'unknown'
  const index = model.placement.tabIndex === null ? '?' : String(model.placement.tabIndex + 1)
  return `${model.placement.tabTitle} · ${index}`
}

function formatPhysicalPlacement(value: AgentStatusModel['placement']['physical']): string {
  if (value === 'detached') return 'detached'
  if (value === 'grid') return 'grid'
  return 'unknown'
}

function statusTone(value: string): AgentStatusField['tone'] {
  if (value === 'running') return 'warn'
  if (value === 'exited') return 'bad'
  if (value === 'idle') return 'good'
  return 'neutral'
}

function processTone(value: string): AgentStatusField['tone'] {
  if (value === 'failed' || value === 'exited') return 'bad'
  if (value === 'spawning') return 'warn'
  if (value === 'started' || value === 'idle') return 'good'
  return 'neutral'
}

function transcriptTone(value: string): AgentStatusField['tone'] {
  if (value === 'error') return 'bad'
  if (value === 'loading') return 'warn'
  if (value === 'ready' || value === 'idle') return 'good'
  return 'neutral'
}
