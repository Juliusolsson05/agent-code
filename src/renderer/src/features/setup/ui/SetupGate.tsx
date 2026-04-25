import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  SetupCheckResult,
  SetupInstallTarget,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup'

const OPTIONAL_INSTALL_TARGET: Partial<Record<SetupToolId, SetupInstallTarget>> = {
  tmux: 'tmux',
  mitmdump: 'mitmproxy',
}

export function SetupGate() {
  const [check, setCheck] = useState<SetupCheckResult | null>(null)
  const [busy, setBusy] = useState<SetupInstallTarget | 'check' | null>('check')
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const refresh = useCallback(async () => {
    setBusy('check')
    setError(null)
    try {
      setCheck(await window.api.setupCheck())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const missingOptional = useMemo(() => {
    if (!check) return []
    return Object.values(check.tools).filter(tool => !tool.required && !tool.found)
  }, [check])

  const shouldShow = Boolean(
    !dismissed &&
      check &&
      (!check.ready || missingOptional.some(tool => tool.installable && !tool.skipped)),
  )

  const install = useCallback(async (target: SetupInstallTarget) => {
    setBusy(target)
    setError(null)
    try {
      const result = await window.api.setupInstall(target)
      setCheck(result.check)
      if (!result.ok) setError(result.output || `Failed to install ${target}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const continueWithOptionalSkipped = useCallback(async () => {
    const skippedTools = missingOptional.filter(tool => tool.installable && !tool.skipped)
    setBusy('check')
    try {
      let next = check
      for (const tool of skippedTools) {
        next = await window.api.setupSkipOptional(tool.id)
      }
      setCheck(next)
      setDismissed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [check, missingOptional])

  if (!shouldShow || !check) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-canvas/95 px-6">
      <div className="w-full max-w-3xl border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[14px] text-ink">Code Setup</div>
          <div className="mt-1 text-[11px] leading-5 text-muted">
            Required tools must be available before agent sessions can start.
          </div>
        </div>

        <div className="divide-y divide-border">
          {Object.values(check.tools).map(tool => (
            <SetupRow
              key={tool.id}
              tool={tool}
              busy={busy}
              onInstall={install}
            />
          ))}
        </div>

        {error ? (
          <div className="border-t border-danger/50 bg-danger/10 px-5 py-3 text-[11px] leading-5 text-danger">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <div className="text-[11px] text-muted">
            Homebrew, Claude Code, and Codex are external prerequisites.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy !== null}
              className="border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Retry
            </button>
            {check.ready ? (
              <button
                type="button"
                onClick={() => void continueWithOptionalSkipped()}
                className="border border-accent bg-accent px-3 py-2 text-[11px] text-accent-fg"
              >
                Continue
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function SetupRow({
  tool,
  busy,
  onInstall,
}: {
  tool: SetupToolStatus
  busy: SetupInstallTarget | 'check' | null
  onInstall: (target: SetupInstallTarget) => void
}) {
  const target = OPTIONAL_INSTALL_TARGET[tool.id]
  const installing = target ? busy === target : false
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-ink">{tool.label}</span>
          <span className={`border px-1.5 py-0.5 text-[10px] ${
            tool.found
              ? 'border-accent text-accent'
              : tool.required
                ? 'border-danger text-danger'
                : 'border-border text-muted'
          }`}>
            {tool.found ? 'Found' : tool.required ? 'Required' : tool.skipped ? 'Skipped' : 'Optional'}
          </span>
        </div>
        <div className="mt-1 truncate text-[11px] text-muted">
          {tool.path ?? tool.detail ?? 'Not found'}
        </div>
      </div>

      {!tool.found && target && tool.installable ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onInstall(target)}
          className="shrink-0 border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
        >
          {installing ? 'Installing…' : 'Install'}
        </button>
      ) : null}
    </div>
  )
}
