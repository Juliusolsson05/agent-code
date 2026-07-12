import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  SetupCheckResult,
  SetupInstallTarget,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup'

// tmux is no longer listed in the SetupGate because it ships as a
// bundled runtime artifact (#120). mitmdump will follow when its
// cleanup PR lands. Keep this map narrowly typed so a future type
// change to SetupToolId/SetupInstallTarget surfaces here too.
const OPTIONAL_INSTALL_TARGET: Partial<Record<SetupToolId, SetupInstallTarget>> = {
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
    // Bundled tools never appear here even when not yet extracted —
    // they ship with the app, so prompting the user to "install
    // tmux/mitmproxy" via Homebrew would be misleading. The bundled
    // archive resolves on first session spawn instead.
    return Object.values(check.tools).filter(
      tool => !tool.required && !tool.found && tool.source !== 'bundled',
    )
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

  // Manual path override (#495 A1). Automatic resolution is a probe and
  // can be wrong (exotic $SHELL, rc-file breakage, Finder-launch PATH) —
  // if a *required* tool is falsely reported missing there must be a way
  // through that isn't "retry the same failing probe". ok:true hands back
  // a fresh check, so a valid path unlocks Continue in one round-trip.
  const setToolPath = useCallback(async (tool: SetupToolId, path: string): Promise<string | null> => {
    setBusy('check')
    setError(null)
    try {
      const result = await window.api.setupSetToolPath(tool, path)
      if (!result.ok) return result.reason
      setCheck(result.check)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
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
    <div
      data-agent-code-interaction-owner="app"
      className="absolute inset-0 z-50 flex items-center justify-center bg-canvas/95 px-6"
    >
      <div className="w-full max-w-3xl border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[14px] text-ink">Agent Code Setup</div>
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
              onSetPath={setToolPath}
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
  onSetPath,
}: {
  tool: SetupToolStatus
  busy: SetupInstallTarget | 'check' | null
  onInstall: (target: SetupInstallTarget) => void
  onSetPath: (tool: SetupToolId, path: string) => Promise<string | null>
}) {
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overridePath, setOverridePath] = useState('')
  const [overrideError, setOverrideError] = useState<string | null>(null)

  const submitOverride = async () => {
    const reason = await onSetPath(tool.id, overridePath)
    setOverrideError(reason)
    if (!reason) {
      setOverrideOpen(false)
      setOverridePath('')
    }
  }
  const target = OPTIONAL_INSTALL_TARGET[tool.id]
  const installing = target ? busy === target : false
  const isBundled = tool.source === 'bundled'
  // Bundled tools always show as "Bundled" regardless of their
  // required/optional metadata — that's the whole point of shipping
  // them with the app, and the install button must never appear for
  // them even if Homebrew is also present on the machine.
  const statusLabel = isBundled
    ? 'Bundled'
    : tool.found
      ? 'Found'
      : tool.required
        ? 'Required'
        : tool.skipped
          ? 'Skipped'
          : 'Optional'
  const statusBorder = isBundled
    ? 'border-accent text-accent'
    : tool.found
      ? 'border-accent text-accent'
      : tool.required
        ? 'border-danger text-danger'
        : 'border-border text-muted'
  const detail = isBundled
    ? 'Shipped with Agent Code; no install required.'
    : (tool.path ?? tool.detail ?? 'Not found')
  // The manual override renders only for missing REQUIRED tools: those
  // are the ones whose false-negative locks the whole app (#495 A1).
  // Optional tools already have Install/Skip affordances and can't block.
  const canOverride = !isBundled && !tool.found && tool.required

  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink">{tool.label}</span>
            <span className={`border px-1.5 py-0.5 text-[10px] ${statusBorder}`}>
              {statusLabel}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted">{detail}</div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canOverride ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setOverrideOpen(open => !open)}
              className="border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Enter path manually…
            </button>
          ) : null}
          {!isBundled && !tool.found && target && tool.installable ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onInstall(target)}
              className="border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              {installing ? 'Installing…' : 'Install'}
            </button>
          ) : null}
        </div>
      </div>

      {canOverride && overrideOpen ? (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={overridePath}
              onChange={e => setOverridePath(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && overridePath.trim()) void submitOverride()
              }}
              placeholder={`/absolute/path/to/${tool.id}`}
              spellCheck={false}
              className="min-w-0 flex-1 border border-border bg-canvas px-2 py-1.5 text-[11px] text-ink placeholder:text-muted focus:border-border-hi focus:outline-none"
            />
            <button
              type="button"
              disabled={busy !== null || !overridePath.trim()}
              onClick={() => void submitOverride()}
              className="border border-border px-3 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Set
            </button>
          </div>
          {overrideError ? (
            <div className="mt-1 text-[11px] text-danger">{overrideError}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
