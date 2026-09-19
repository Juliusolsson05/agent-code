import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  SetupInstallTarget,
  SetupToolId,
  SetupToolStatus,
} from '@shared/types/setup'
import { refreshSetupCheck, useSetupStore } from '@renderer/features/setup/store'

// tmux is no longer listed in the SetupGate because it ships as a
// bundled runtime artifact (#120). mitmdump will follow when its
// cleanup PR lands. Keep this map narrowly typed so a future type
// change to SetupToolId/SetupInstallTarget surfaces here too.
const OPTIONAL_INSTALL_TARGET: Partial<Record<SetupToolId, SetupInstallTarget>> = {
  mitmdump: 'mitmproxy',
}

/**
 * The setup panel: which provider CLIs and helper tools this Mac has, and how
 * to get the missing ones.
 *
 * WHY it can never lock the app (#995): it used to block until BOTH Claude
 * Code and Codex were installed, with no Continue button, no install
 * instructions and no way back once dismissed. A fresh Mac met a wall, even
 * in the packaged app where OpenCode ships bundled and works. Now:
 * - It opens by itself only when there is nothing to run agents with, or
 *   when a helper Homebrew can install is missing (the behavior that was
 *   already here). "Continue with a terminal" always answers it.
 * - It opens on request from the File menu or the "Open Setup" command, and
 *   then Escape or Close closes it.
 * - Missing providers show a copyable install command and a docs link. The
 *   manual path override stays, because the probes can be wrong (#495 A1).
 */
export function SetupGate() {
  const check = useSetupStore(state => state.check)
  const error = useSetupStore(state => state.error)
  const requested = useSetupStore(state => state.requested)
  const dismissed = useSetupStore(state => state.dismissed)
  const [busy, setBusy] = useState<SetupInstallTarget | 'check' | null>('check')
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy('check')
    setActionError(null)
    await refreshSetupCheck()
    setBusy(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Opening on request re-probes: the user may have just run an installer
  // in a terminal pane, and a stale "Not installed" would contradict them.
  useEffect(() => {
    if (requested) void refresh()
  }, [requested, refresh])

  const noProvider = check !== null && check.usableProviders.length === 0

  const missingOptional = useMemo(() => {
    if (!check) return []
    // Bundled tools never appear here even when not yet extracted —
    // they ship with the app, so prompting the user to "install
    // tmux/mitmproxy" via Homebrew would be misleading. The bundled
    // archive resolves on first session spawn instead.
    return Object.values(check.tools).filter(
      tool => !tool.provider && !tool.found && tool.source !== 'bundled',
    )
  }, [check])

  const automatic = Boolean(
    !dismissed &&
      check &&
      (noProvider || missingOptional.some(tool => tool.installable && !tool.skipped)),
  )
  const shouldShow = Boolean(check && (requested || automatic))

  const install = useCallback(async (target: SetupInstallTarget) => {
    setBusy(target)
    setActionError(null)
    try {
      const result = await window.api.setupInstall(target)
      useSetupStore.getState().setCheck(result.check)
      if (!result.ok) setActionError(result.output || `Failed to install ${target}`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  // Manual path override (#495 A1). Automatic resolution is a probe and
  // can be wrong (exotic $SHELL, rc-file breakage, Finder-launch PATH), so
  // there must be a way through that isn't "retry the same failing probe".
  // ok:true hands back a fresh check, so a valid path takes effect in one
  // round-trip.
  const setToolPath = useCallback(async (tool: SetupToolId, path: string): Promise<string | null> => {
    setBusy('check')
    setActionError(null)
    try {
      const result = await window.api.setupSetToolPath(tool, path)
      if (!result.ok) return result.reason
      useSetupStore.getState().setCheck(result.check)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      setBusy(null)
    }
  }, [])

  // Answers the automatic panel. Optional installable helpers the user did
  // not install are recorded as skipped (the pre-#995 behavior), so they
  // stop reopening it on every launch. With no provider, this is the
  // explicit "yes, just a terminal for now" acknowledgment.
  const continueOn = useCallback(async () => {
    const skippedTools = missingOptional.filter(tool => tool.installable && !tool.skipped)
    setBusy('check')
    try {
      for (const tool of skippedTools) {
        useSetupStore.getState().setCheck(await window.api.setupSkipOptional(tool.id))
      }
      useSetupStore.getState().close()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [missingOptional])

  // Escape closes a panel the user opened. The automatic zero-provider panel
  // is answered only by its button: the acknowledgment is the point of it,
  // and an Escape pressed for something else must not silently decide that
  // the first project is a terminal.
  useEffect(() => {
    if (!shouldShow || !requested) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      useSetupStore.getState().close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shouldShow, requested])

  if (!shouldShow || !check) return null

  const providers = Object.values(check.tools).filter(tool => tool.provider)
  const helpers = Object.values(check.tools).filter(tool => !tool.provider)
  const shownError = actionError ?? error

  return (
    <div
      data-agent-code-interaction-owner="app"
      role="dialog"
      aria-modal="true"
      aria-label="Agent Code Setup"
      className="absolute inset-0 z-50 flex items-center justify-center bg-canvas/95 px-6"
    >
      <div className="rounded-slab flex max-h-[90vh] w-full max-w-3xl flex-col border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[14px] text-ink">
            {noProvider ? 'No agent provider is installed yet' : 'Agent Code Setup'}
          </div>
          <div className="mt-1 text-[11px] leading-5 text-muted">
            {noProvider
              ? 'Install one of the CLIs below in a terminal, then press Retry. Or continue with a terminal now and install from there. Setup stays available from the File menu and the command palette.'
              : 'The agent CLIs and helper tools on this Mac, and how to add the ones that are missing.'}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto">
          <SectionLabel>Agent providers</SectionLabel>
          <div className="divide-y divide-border">
            {providers.map(tool => (
              <SetupRow key={tool.id} tool={tool} busy={busy} onInstall={install} onSetPath={setToolPath} />
            ))}
          </div>
          <SectionLabel>Helper tools</SectionLabel>
          <div className="divide-y divide-border">
            {helpers.map(tool => (
              <SetupRow key={tool.id} tool={tool} busy={busy} onInstall={install} onSetPath={setToolPath} />
            ))}
          </div>
        </div>

        {shownError ? (
          <div className="border-t border-danger/50 bg-danger/10 px-5 py-3 text-[11px] leading-5 text-danger">
            {shownError}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-4">
          <div className="text-[11px] text-muted">
            Any one provider is enough. A terminal pane needs none.
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy !== null}
              className="rounded-control border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Retry
            </button>
            {requested && !automatic ? (
              <button
                type="button"
                onClick={() => useSetupStore.getState().close()}
                className="rounded-control border border-accent bg-accent px-3 py-2 text-[11px] text-accent-fg"
              >
                Close
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void continueOn()}
                disabled={busy !== null}
                className="rounded-control border border-accent bg-accent px-3 py-2 text-[11px] text-accent-fg disabled:opacity-50"
              >
                {noProvider ? 'Continue with a terminal' : 'Continue'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="border-b border-border bg-canvas/40 px-5 py-1.5 text-[10px] uppercase tracking-wide text-muted">
      {children}
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
  const [copied, setCopied] = useState(false)

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
  // Bundled tools always show as "Bundled": that is the whole point of
  // shipping them with the app, and the install button must never appear for
  // them even if Homebrew is also present on the machine.
  const statusLabel = isBundled
    ? 'Bundled'
    : tool.found
      ? 'Found'
      : tool.provider
        ? 'Not installed'
        : tool.skipped
          ? 'Skipped'
          : 'Optional'
  const statusBorder = tool.found || isBundled ? 'border-accent text-accent' : 'border-border text-muted'
  const detail = isBundled
    ? 'Shipped with Agent Code; no install required.'
    : (tool.path ?? tool.detail ?? 'Not found')
  const missingProvider = tool.provider && !tool.found && !isBundled
  // The manual override is for providers: a false "Not installed" is the one
  // probe error that costs the user an agent (#495 A1). Helpers have
  // Install/Skip and never gate anything.
  const canOverride = missingProvider

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard denied: the command is selectable text right beside the
      // button, so the user can still copy it by hand.
    }
  }

  return (
    <div className="px-5 py-3" data-setup-tool={tool.id}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink">{tool.label}</span>
            <span className={`rounded-chip border px-1.5 py-0.5 text-[10px] ${statusBorder}`}>
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
              className="rounded-control border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Enter path manually…
            </button>
          ) : null}
          {!isBundled && !tool.found && target && tool.installable ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onInstall(target)}
              className="rounded-control border border-border px-3 py-2 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              {installing ? 'Installing…' : 'Install'}
            </button>
          ) : null}
        </div>
      </div>

      {missingProvider && tool.installCommand ? (
        <div className="mt-2 flex items-center gap-2">
          <code className="rounded-control min-w-0 flex-1 select-all truncate border border-border bg-canvas px-2 py-1.5 text-[11px] text-ink">
            {tool.installCommand}
          </code>
          <button
            type="button"
            onClick={() => void copy(tool.installCommand!)}
            className="rounded-control border border-border px-3 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {tool.docsUrl ? (
            <a
              href={tool.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-accent underline"
            >
              Docs
            </a>
          ) : null}
        </div>
      ) : null}

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
              className="rounded-control min-w-0 flex-1 border border-border bg-canvas px-2 py-1.5 text-[11px] text-ink placeholder:text-muted focus:border-border-hi focus:outline-none"
            />
            <button
              type="button"
              disabled={busy !== null || !overridePath.trim()}
              onClick={() => void submitOverride()}
              className="rounded-control border border-border px-3 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
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
