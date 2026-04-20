import { useMemo } from 'react'

import type { SessionRuntime } from './tiles/workspaceStore'
import type { Entry } from '../../shared/types/transcript'

// DebugPanel — inline diagnostic overlay showing the raw state of the
// focused pane. Toggled via "Toggle Debug Panel" in the command palette.
//
// Shows:
//   - Session kind + activity status
//   - Raw screen text (last 20 lines)
//   - Screen markdown (last 20 lines)
//   - Streaming baseline
//   - awaitingAssistant flag
//   - JSONL entry count + last 5 entries (type + summary)
//   - Queued messages
//   - Picker state
//   - Draft input

type Props = {
  sessionId: string
  runtime: SessionRuntime
  kind: string
  onClose: () => void
}

export function DebugPanel({ sessionId, runtime, kind, onClose }: Props) {
  const screenTail = useMemo(() => {
    const lines = runtime.screen.split('\n')
    return lines.slice(-20).join('\n')
  }, [runtime.screen])

  const mdTail = useMemo(() => {
    const lines = runtime.screenMarkdown.split('\n')
    return lines.slice(-20).join('\n')
  }, [runtime.screenMarkdown])

  const lastEntries = useMemo(() => {
    return runtime.entries.slice(-5).map(summarizeEntry)
  }, [runtime.entries])

  return (
    <div className="
      h-full w-[380px] flex-shrink-0
      border-l border-border bg-[#0c0c0c]
      flex flex-col
      overflow-hidden
      text-[10px] font-code
    ">
      {/* Header */}
      <div className="
        flex items-center justify-between
        px-3 py-2
        border-b border-border
        text-[9px] text-red-400 uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>debug — {kind} session</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink text-[14px] leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-3">
        {/* State flags */}
        <Section title="state">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <Flag label="sessionId" value={sessionId.slice(0, 12)} />
            <Flag label="kind" value={kind} />
            <Flag label="sessionStatus" value={runtime.sessionStatus} />
            <Flag label="statusSource" value={runtime.sessionStatusSource} />
            <Flag label="processActive" on={runtime.processActive} />
            <Flag label="awaitingAssistant" on={runtime.awaitingAssistant} />
            <Flag label="exited" value={runtime.exited === null ? 'running' : String(runtime.exited)} />
            <Flag label="activityStatus" value={runtime.activityStatus ?? '(idle)'} />
            <Flag label="streamPhase" value={runtime.streamPhase} />
            <Flag
              label="pendingTool"
              value={runtime.streamPhasePendingToolName ?? '(none)'}
            />
            <Flag
              label="turnStartedAt"
              value={
                runtime.turnStartedAt === null
                  ? '(none)'
                  : `${((Date.now() - runtime.turnStartedAt) / 1000).toFixed(1)}s ago`
              }
            />
            <Flag label="picker.visible" on={runtime.picker.visible} />
            <Flag label="entries" value={String(runtime.entries.length)} />
            <Flag label="queuedMsgs" value={String(runtime.queuedMessages.length)} />
          </div>
        </Section>

        {/* Draft input */}
        {runtime.draftInput && (
          <Section title="draft input">
            <Pre>{runtime.draftInput}</Pre>
          </Section>
        )}

        {/* Streaming baseline */}
        <Section title="streaming baseline">
          <Pre>{runtime.streamingBaseline ?? '(null)'}</Pre>
        </Section>

        {/* Queued messages */}
        {runtime.queuedMessages.length > 0 && (
          <Section title={`queued messages (${runtime.queuedMessages.length})`}>
            {runtime.queuedMessages.map((q, i) => (
              <Pre key={i}>{q.content}</Pre>
            ))}
          </Section>
        )}

        {/* Last 5 entries */}
        <Section title={`last ${lastEntries.length} entries (of ${runtime.entries.length})`}>
          {lastEntries.map((s, i) => (
            <Pre key={i}>{s}</Pre>
          ))}
          {lastEntries.length === 0 && <Pre>(no entries)</Pre>}
        </Section>

        {/* Raw screen tail */}
        <Section title="raw screen (last 20 lines)">
          <Pre>{screenTail || '(empty)'}</Pre>
        </Section>

        {/* Markdown screen tail */}
        <Section title="markdown screen (last 20 lines)">
          <Pre>{mdTail || '(empty)'}</Pre>
        </Section>

        {/* Project dir */}
        <Section title="project dir">
          <Pre>{runtime.projectDir ?? '(none)'}</Pre>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] text-muted uppercase tracking-wider mb-1 select-none">
        {title}
      </div>
      {children}
    </div>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="
      bg-[#111] border border-[#222] px-2 py-1
      text-[10px] leading-[1.4] text-ink-dim
      whitespace-pre-wrap break-all
      max-h-[150px] overflow-auto
      m-0
    ">
      {children}
    </pre>
  )
}

function Flag({ label, value, on }: { label: string; value?: string; on?: boolean }) {
  const display = value ?? (on ? 'true' : 'false')
  const color = on === true ? 'text-green-400' : on === false ? 'text-red-400' : 'text-ink-dim'
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <span className={color}>{display}</span>
    </div>
  )
}

function summarizeEntry(entry: Entry): string {
  const e = entry as Record<string, unknown>
  const type = String(e.type ?? '?')

  // Codex rollout entries have { type, timestamp, payload }
  if (e.payload && typeof e.payload === 'object') {
    const p = e.payload as Record<string, unknown>
    const pt = String(p.type ?? '')
    const role = String(p.role ?? '')
    if (pt === 'message') return `${type} → ${pt} (${role})`
    if (pt === 'function_call') return `${type} → ${pt}: ${String(p.name ?? '')}()`
    if (pt === 'function_call_output') return `${type} → ${pt}`
    return `${type} → ${pt}`
  }

  // Claude entries have { type, message: { role, content } }
  const msg = e.message as Record<string, unknown> | undefined
  if (msg) {
    const role = String(msg.role ?? '')
    const content = msg.content
    if (typeof content === 'string') return `${type} (${role}): ${content.slice(0, 40)}`
    if (Array.isArray(content)) {
      const first = content[0] as Record<string, unknown> | undefined
      if (first?.type === 'text') return `${type} (${role}): ${String(first.text ?? '').slice(0, 40)}`
      if (first?.type === 'tool_use') return `${type} (${role}): tool_use ${String(first.name ?? '')}`
      return `${type} (${role}): ${String(first?.type ?? '?')}`
    }
    return `${type} (${role})`
  }

  return type
}
