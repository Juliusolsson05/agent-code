import { useEffect, useMemo, useState } from 'react'

import { devDebugModules } from '@renderer/features/debug/devModules/registry'
import type {
  DevDebugCopyMode,
  DevDebugModule,
  DevDebugModuleProps,
} from '@renderer/features/debug/devModules/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

const STORAGE_KEY = 'agent-code:dev-debug:enabled-modules'

type Props = {
  sessionId: string
  runtime: SessionRuntime
  kind: string
  workspace: Workspace
  onClose: () => void
}

export function DevDebugPanel({ sessionId, runtime, kind, workspace, onClose }: Props) {
  const [enabledIds, setEnabledIds] = useState<string[]>(() => readEnabledIds())
  const [copied, setCopied] = useState<string | null>(null)
  const moduleIds = useMemo(() => new Set(devDebugModules.map(module => module.id)), [])

  useEffect(() => {
    setEnabledIds(prev => {
      const next = prev.filter(id => moduleIds.has(id))
      if (next.length !== prev.length) writeEnabledIds(next)
      return next
    })
  }, [moduleIds])

  const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds])
  const enabledModules = useMemo(
    () => devDebugModules.filter(module => enabledSet.has(module.id)),
    [enabledSet],
  )

  const toggleModule = (module: DevDebugModule) => {
    setEnabledIds(prev => {
      const next = prev.includes(module.id)
        ? prev.filter(id => id !== module.id)
        : [...prev, module.id]
      writeEnabledIds(next)
      return next
    })
  }

  const moduleProps: DevDebugModuleProps = { sessionId, runtime, kind, workspace }

  const copyModule = (module: DevDebugModule, mode: DevDebugCopyMode) => {
    const text = module.buildCopyText
      ? module.buildCopyText(moduleProps, mode)
      : buildDefaultCopyText(module, moduleProps, mode)
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(`${module.id}:${mode}`)
      window.setTimeout(() => {
        setCopied(current => current === `${module.id}:${mode}` ? null : current)
      }, 1400)
    })
  }

  const copyEnabledModules = (mode: DevDebugCopyMode) => {
    const text = enabledModules
      .map(module =>
        module.buildCopyText
          ? module.buildCopyText(moduleProps, mode)
          : buildDefaultCopyText(module, moduleProps, mode),
      )
      .join('\n\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(`all:${mode}`)
      window.setTimeout(() => {
        setCopied(current => current === `all:${mode}` ? null : current)
      }, 1400)
    })
  }

  return (
    <div className="
      h-full w-[620px] flex-shrink-0
      border-l border-border bg-[#0c0c0c]
      flex flex-col overflow-hidden
      text-[10px] font-code
    ">
      <div className="
        flex items-center justify-between
        px-3 py-2 border-b border-border
        text-[9px] text-red-400 uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>dev debug</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink text-[14px] leading-none"
        >
          ×
        </button>
      </div>

      <div className="border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] text-muted uppercase tracking-[0.12em]">
              focused session
            </div>
            <div className="mt-0.5 text-[11px] text-ink-dim truncate">
              {kind} · {sessionId}
            </div>
          </div>
          <div className="text-[10px] text-muted tabular-nums">
            {enabledModules.length}/{devDebugModules.length} modules
          </div>
        </div>
        {enabledModules.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5">
            <CopyButton
              label={copied === 'all:useful' ? 'copied useful' : 'copy useful'}
              onClick={() => copyEnabledModules('useful')}
            />
            <CopyButton
              label={copied === 'all:full' ? 'copied full' : 'copy full'}
              onClick={() => copyEnabledModules('full')}
            />
          </div>
        )}
      </div>

      <div className="border-b border-border bg-[#101010] px-3 py-2">
        {devDebugModules.length === 0 ? (
          <div className="text-[11px] text-muted">no dev debug modules registered</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {devDebugModules.map(module => {
              const enabled = enabledSet.has(module.id)
              return (
                <button
                  key={module.id}
                  type="button"
                  onClick={() => toggleModule(module)}
                  className={`border px-2 py-1 text-left transition-colors ${
                    enabled
                      ? 'border-accent/70 bg-accent/10 text-ink'
                      : 'border-border/70 bg-canvas text-ink-dim hover:border-border-hi hover:text-ink'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px]">{module.title}</span>
                    <span className={enabled ? 'text-accent' : 'text-muted'}>
                      {enabled ? 'on' : 'off'}
                    </span>
                  </div>
                  {module.description && (
                    <div className="mt-0.5 text-[10px] text-muted">
                      {module.description}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-3">
        {enabledModules.length === 0 ? (
          <div className="border border-border bg-[#101010] px-3 py-4 text-center text-[11px] text-muted">
            no dev debug modules enabled
          </div>
        ) : (
          enabledModules.map(module => (
            <div key={module.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-[9px] uppercase tracking-[0.12em] text-muted truncate">
                  {module.title}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <CopyButton
                    label={copied === `${module.id}:useful` ? 'copied useful' : 'copy useful'}
                    onClick={() => copyModule(module, 'useful')}
                  />
                  <CopyButton
                    label={copied === `${module.id}:full` ? 'copied full' : 'copy full'}
                    onClick={() => copyModule(module, 'full')}
                  />
                </div>
              </div>
              <module.Component
                sessionId={sessionId}
                runtime={runtime}
                kind={kind}
                workspace={workspace}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function CopyButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-border/80 px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-border-hi hover:text-ink"
    >
      {label}
    </button>
  )
}

function buildDefaultCopyText(
  module: DevDebugModule,
  { sessionId, runtime, kind }: DevDebugModuleProps,
  mode: DevDebugCopyMode,
): string {
  const full = mode === 'full'
  const payload = {
    module: {
      id: module.id,
      title: module.title,
      copyMode: mode,
      copiedAt: new Date().toISOString(),
    },
    session: {
      sessionId,
      kind,
      streamPhase: runtime.streamPhase,
      processStatus: runtime.processStatus,
      transcriptStatus: runtime.transcriptStatus,
      inputReady: runtime.inputReady,
      exited: runtime.exited,
    },
    runtime: {
      conditions: runtime.conditions,
      picker: runtime.picker,
      assistantPicker: runtime.assistantPicker,
      codeBlockPicker: runtime.codeBlockPicker,
      pendingTrustDialog: runtime.pendingTrustDialog,
      pendingPermissionPrompt: runtime.pendingPermissionPrompt,
      pendingResumePrompt: runtime.pendingResumePrompt,
      pendingCompaction: runtime.pendingCompaction,
      pendingApproval: runtime.pendingApproval,
      totalEntries: runtime.totalEntries,
      entriesShown: runtime.entries.length,
      lastJsonlEntryAt: runtime.lastJsonlEntryAt,
      turnStartedAt: runtime.turnStartedAt,
      semantic: {
        currentTurn: runtime.semantic.currentTurn,
        history: full ? runtime.semantic.history : runtime.semantic.history.slice(-5),
        log: full ? runtime.semantic.log : runtime.semantic.log.slice(-20),
      },
      feedDebugLog: full ? runtime.feedDebugLog : runtime.feedDebugLog.slice(-30),
      screen: full ? runtime.screen : runtime.screen.slice(-2000),
      screenMarkdown: full ? runtime.screenMarkdown : runtime.screenMarkdown.slice(-2000),
      entries: full ? runtime.entries : undefined,
    },
  }
  return formatCopyPayload(module.title, payload)
}

function formatCopyPayload(title: string, payload: unknown): string {
  return [
    `# ${title}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

function readEnabledIds(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function writeEnabledIds(ids: string[]): void {
  try {
    // WHY only ids are persisted: module state is investigation-local.
    // A regex probe may want one storage key, a future submit timeline
    // may want another, and many modules should leave no residue at
    // all. The host persists visibility only so deleting a temporary
    // module does not strand a schema-shaped blob in app settings.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // localStorage can throw in restricted environments; losing a
    // debug-panel toggle is not worth surfacing to the product UI.
  }
}
