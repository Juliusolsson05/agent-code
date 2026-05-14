import { useEffect, useMemo, useState } from 'react'

import { devDebugModules } from '@renderer/features/debug/devModules/registry'
import type { DevDebugModule } from '@renderer/features/debug/devModules/types'
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
            <module.Component
              key={module.id}
              sessionId={sessionId}
              runtime={runtime}
              kind={kind}
              workspace={workspace}
            />
          ))
        )}
      </div>
    </div>
  )
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
