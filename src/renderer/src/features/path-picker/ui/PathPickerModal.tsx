import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { PathInput } from '@renderer/features/path-picker/ui/PathInput'
import { ConversationRow } from '@renderer/features/conversations/ui/ConversationRow'
// Rows are the catalog's Conversation: the same shape the Conversations
// picker renders, so a session looks the same in both places and the label,
// provenance and ordering decisions live in main, not here.
import type { Conversation } from '@shared/conversations/types'

// PathPickerModal — modal that asks the user for a working directory
// when they press ⌘T (or click the + button in the tab bar).
//
// Responsibilities:
//   - Let the user type a path (with completion via PathInput).
//   - Validate the path via window.api.expandCwd on submit/interaction.
//   - Show the conversations recorded in that cwd for the toggled provider
//     (through the conversation catalog, scope 'cwd') so the user can
//     RESUME an existing session instead of starting fresh.
//   - On open: start a fresh session in the validated cwd.
//   - On resume click: spawn with --resume <sessionId>.
//
// All the completion machinery lives in <PathInput>; this file owns
// the modal chrome, session list fetching, and the submit → validate
// → spawn wiring.

export type AgentProvider = AgentProviderKind

type Props = {
  open: boolean
  defaultValue?: string
  onCancel: () => void
  /** Called when the user opens a brand-new session for `cwd`.
   *  Now carries the selected provider so App knows which kind to spawn. */
  onAccept: (expandedPath: string, provider: AgentProvider) => void | Promise<void>
  /** Called when the user picks a previous session to resume. */
  onResume: (
    expandedPath: string,
    sessionId: string,
    provider: AgentProvider,
  ) => void | Promise<void>
  /**
   * Tabs that already hold a session in `expandedPath` (#913), in tab order,
   * with `current` marking the active tab. When any exist, Enter and the
   * primary button go to one of them instead of creating a duplicate tab;
   * "new tab anyway" and Shift+Enter keep the deliberate case. Absent means
   * the caller has no workspace to consult (tests, embedding).
   */
  openTabsForPath?: (expandedPath: string) => OpenTabHolder[]
  onActivateTab?: (tabId: string) => void
}

export type OpenTabHolder = { tabId: string; label: string; current: boolean }

/**
 * Which holder Enter goes to when several tabs hold the folder.
 *
 * WHY the current tab wins: ⌘T pre-fills the active tab's folder, so with
 * tabs B, E and G all on the same repository and G active, "first in tab
 * order" would jump the user from G to B for pressing Enter on the default.
 * Staying put is the only answer that never surprises. Otherwise the first
 * holder in tab order is taken, which is a guess the operator capability
 * `projects.open` deliberately refuses to make (`ambiguous_owner`): an
 * operator has no "current tab" and no hint on screen, while the user here
 * sees every holder named and can still pick "new tab anyway".
 */
function preferredHolder(holders: OpenTabHolder[]): OpenTabHolder | null {
  return holders.find(holder => holder.current) ?? holders[0] ?? null
}

export function PathPickerModal({
  open,
  defaultValue = '',
  onCancel,
  onAccept,
  onResume,
  openTabsForPath,
  onActivateTab,
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Provider toggle: Claude (default) or Codex. Resets on modal open.
  const [provider, setProvider] = useState<AgentProvider>(DEFAULT_PROVIDER)

  // Resume list state. We eagerly refresh the list whenever the path
  // changes and resolves to a valid directory — gives the user live
  // feedback as they type (e.g. "ah, no recorded sessions in this
  // folder yet, I'll start fresh").
  const [sessions, setSessions] = useState<Conversation[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [listingError, setListingError] = useState<string | null>(null)
  const [listingTarget, setListingTarget] = useState<{
    cwd: string
    provider: AgentProvider
  } | null>(null)
  // Latest resolved absolute path. Tracked separately from `value` so
  // actions use the validated form rather than re-running expand.
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  // Absolute path that will be created if the user submits while the
  // typed path doesn't exist on disk yet. Non-null whenever the debounced
  // expandCwd call reported `does not exist` and the picker is therefore
  // in "Create & Open" mode. Distinct from resolvedPath because we want
  // ResumeSection / session listing to stay quiet for paths that don't
  // exist yet — there are no sessions to list for a directory that
  // hasn't been created.
  const [pendingCreatePath, setPendingCreatePath] = useState<string | null>(null)
  // Debounce token for the session list refresh — see the effect below.
  const reqVersion = useRef(0)

  const invalidateResumeListing = (): void => {
    // This is called from the initiating UI event as well as repeated in the
    // effect. Effects run after commit; clearing only there permits one painted
    // frame where an old row is still clickable under a new visible target.
    setSessions([])
    setListingTarget(null)
    setListingError(null)
  }

  // Reset on open so a stale error / value from a previous attempt
  // doesn't carry over.
  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setError(null)
    setBusy(false)
    setSessions([])
    setSessionsLoading(false)
    setListingError(null)
    setListingTarget(null)
    setResolvedPath(null)
    setPendingCreatePath(null)
    setProvider(DEFAULT_PROVIDER)
  }, [open, defaultValue])

  // Refresh the sessions list whenever the typed path changes. Run
  // expandCwd to both validate the path AND get the absolute form the
  // catalog is asked about. Debounced 150ms so we don't hammer main on
  // every keystroke.
  useEffect(() => {
    if (!open) return
    const v = ++reqVersion.current
    // WHY invalidate before starting the debounce: the provider toggle
    // and path field change immediately, so rows from the previous target must
    // stop being actionable immediately too. Waiting for the replacement IPC
    // response creates a window where a Claude row can be resumed as Codex.
    setSessions([])
    setListingTarget(null)
    setListingError(null)
    setSessionsLoading(true)
    const t = setTimeout(async () => {
      const result = await window.api.expandCwd(value)
      if (v !== reqVersion.current) return
      if (!result.ok) {
        // Don't surface the error as a modal-level error just because
        // the user is mid-typing. Only clear the session list and
        // resolved path so the list doesn't lie.
        setResolvedPath(null)
        setSessions([])
        setSessionsLoading(false)
        // If the path simply doesn't exist yet, surface the create-and-open
        // affordance. Other errors (`not a directory`, `permission denied`,
        // `path is empty`) deliberately don't get this treatment — we don't
        // want to offer "Create" when the user typed a path that points at
        // a file, or one they can't traverse.
        if (result.error === 'does not exist' && result.resolvedPath) {
          setPendingCreatePath(result.resolvedPath)
        } else {
          setPendingCreatePath(null)
        }
        return
      }
      // Path exists — clear any prior pending-create state from a path
      // that was just tab-completed into an existing directory.
      setPendingCreatePath(null)
      setResolvedPath(result.path)
      try {
        // Scope 'cwd', not 'repository': this picker is about one typed
        // directory, and a worktree's sessions listed under the main checkout
        // would resume in the wrong tree.
        const listing = await window.api.listConversations({ cwd: result.path, scope: 'cwd', providers: [provider], includeChildren: false, limit: 50 })
        if (v !== reqVersion.current) return
        setSessions(listing.rows)
        setListingTarget({ cwd: result.path, provider })
        setListingError(null)
      } catch {
        if (v !== reqVersion.current) return
        // WHY listing failure does not invalidate the cwd: starting a fresh
        // session is still safe and useful. Keep the validated path, clear only
        // the stale resume rows, and make the disk/provider failure visible
        // instead of misreporting it as a successful zero-result scan.
        setSessions([])
        setListingTarget(null)
        setListingError('Unable to load saved sessions. You can still start a new session.')
      } finally {
        if (v === reqVersion.current) setSessionsLoading(false)
      }
    }, 150)
    return () => clearTimeout(t)
  }, [value, open, provider])

  // Decided at submit time from the freshly expanded path, never from the
  // debounced `resolvedPath` the hint below renders: the user can press Enter
  // before the debounce settles, and the choice must follow the path that is
  // actually about to be opened. The buttons are the one exception — see the
  // footer: a button does what its label says, and the label is what the
  // debounced hint knew.
  const holdersOf = (expandedPath: string): OpenTabHolder[] =>
    (onActivateTab && openTabsForPath ? openTabsForPath(expandedPath) : [])

  const submit = async (options: { forceNewTab?: boolean } = {}) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // First pass: try to validate the typed path as-is. If it exists,
      // open it. If it specifically "does not exist", create it and then
      // re-validate so the cwd we hand to session spawning is the same
      // canonical absolute path expandCwd would produce — never the raw
      // user input.
      const result = await window.api.expandCwd(value)
      if (result.ok) {
        const holder = options.forceNewTab ? null : preferredHolder(holdersOf(result.path))
        if (holder) {
          // The folder is already on screen: go there instead of minting the
          // duplicate tab that ⌘T used to create every time (#913). When the
          // holder is the current tab this is a stay-put that only closes
          // the picker; the primary button says so ("stay here"). The
          // provider toggle is irrelevant on this path — nothing is spawned.
          onActivateTab!(holder.tabId)
          return
        }
        await onAccept(result.path, provider)
        return
      }
      if (result.error !== 'does not exist') {
        setError(result.error)
        return
      }
      const created = await window.api.createDirectory(value)
      if (!created.ok) {
        setError(created.error)
        return
      }
      // Re-run expandCwd to get the canonical resolved path and to
      // defend against the (vanishingly unlikely) case where something
      // races between mkdir and the spawn — if validation now fails for
      // any reason, we'd rather surface that error than hand a possibly-
      // stale path to onAccept.
      const reValidated = await window.api.expandCwd(value)
      if (!reValidated.ok) {
        setError(reValidated.error)
        return
      }
      await onAccept(reValidated.path, provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resume = async (sessionId: string) => {
    if (busy) return
    // Rows exist only with an accepted listing target. Keeping this explicit
    // makes a stale closure or synthetic click fail closed instead of pairing
    // a historical session id with today's provider toggle.
    const row = sessions.find(session => session.nativeId === sessionId)
    // An unavailable row (index remembers it, transcript file gone) is shown
    // for the record and is never a resume target.
    if (!listingTarget || !row || !row.available) return
    setBusy(true)
    setError(null)
    try {
      await onResume(listingTarget.cwd, row.nativeId, row.provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Display only; `submit` re-derives from the path it is about to open.
  const alreadyOpenAs = resolvedPath && !pendingCreatePath ? holdersOf(resolvedPath) : []
  const preferred = preferredHolder(alreadyOpenAs)
  const otherHolders = alreadyOpenAs.filter(holder => holder !== preferred)

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent
        className="modal-pop flex max-h-[80vh] w-[620px] max-w-[calc(100vw-64px)] flex-col p-6"
      >
        <DialogTitle className="mb-3 flex-shrink-0 font-semibold">
          New tab — working directory
        </DialogTitle>
        <DialogDescription className="sr-only">
          Choose a provider and working directory, then start or resume a session.
        </DialogDescription>

        {/* Provider toggle: Claude / Codex */}
        <div className="flex gap-2 mb-3 flex-shrink-0">
          {AGENT_PROVIDER_KINDS.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => {
                if (p !== provider) invalidateResumeListing()
                setProvider(p)
              }}
              className={`rounded-control
                px-3 py-1 text-[11px] font-semibold uppercase tracking-wider
                border transition-colors duration-120
                ${provider === p
                  ? 'bg-accent text-accent-fg border-accent'
                  : 'bg-transparent text-muted border-border hover:border-border-hi hover:text-ink'}
              `}
            >
              {getRendererProviderCapabilities(p).shortLabel}
            </button>
          ))}
        </div>

        <div className="relative mb-2 flex-shrink-0">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-accent text-[12px] pointer-events-none select-none z-10">
            ❯
          </div>
          <PathInput
            value={value}
            onChange={next => {
              if (next !== value) invalidateResumeListing()
              setValue(next)
              if (error) setError(null)
            }}
            onSubmit={({ shift }) => void submit({ forceNewTab: shift })}
            onCancel={onCancel}
            placeholder="/path/to/project or ~/…"
            directoriesOnly
            autoFocus
            disabled={busy}
            inputClassName={`
              w-full
              bg-canvas text-ink text-[12px]
              pl-6 pr-3 py-2.5
              border
              ${error ? 'border-danger' : 'border-border'}
              focus:border-accent
              outline-none
              transition-colors duration-120
            `}
          />
        </div>

        {/* Error / create-hint slot.
            Error wins over the create-hint when both could apply: the
            user only sees "Will create:" when the underlying state is
            actually creatable (does-not-exist), so once they submit and
            get an error back, that error is the more urgent thing to
            show. */}
        <div className="min-h-[16px] text-[11px] mb-3 flex-shrink-0">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : pendingCreatePath ? (
            <span className="text-accent">
              Will create:{' '}
              <span className="text-ink">{pendingCreatePath}</span>
            </span>
          ) : (
            <span className="text-muted">
              {preferred
                ? 'tab completes · ↑↓ to browse · enter to go there · ⇧enter for a new tab anyway · esc to cancel'
                : 'tab completes · ↑↓ to browse · enter to open · esc to cancel'}
            </span>
          )}
        </div>

        {/* Resume section — shows the most recent sessions recorded in
            the currently-typed cwd. Click a row to spawn with --resume. */}
        <ResumeSection
          resolvedPath={resolvedPath}
          sessions={sessions}
          loading={sessionsLoading}
          onResume={resume}
          disabled={busy}
        />

        {listingError && (
          <div role="alert" className="mt-2 text-[11px] text-danger flex-shrink-0">
            {listingError}
          </div>
        )}

        {preferred && (
          <div role="status" className="mt-2 flex-shrink-0 text-[11px] text-muted">
            {preferred.current
              ? `Already open in this tab (${preferred.label})`
              : `Already open as ${preferred.label}`}
            {otherHolders.length > 0 ? `, and as ${otherHolders.map(tab => tab.label).join(', ')}` : ''}.
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 flex-shrink-0">
          <Button
            type="button"
            onClick={onCancel}
            disabled={busy}
            variant="outline"
          >
            cancel
          </Button>
          {/* WHY every button forces the action its label names: the labels
              follow the debounced hint, and a click can land before the hint
              has caught up with the typed path. Letting `submit` re-decide
              would then switch tabs under a button that said "new session".
              Enter is the only submit that decides at submit time, because
              Enter carries no label to honour and reuse is the safer default
              for a keypress that outran the hint. */}
          {preferred ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => void submit({ forceNewTab: true })}
                disabled={busy}
              >
                new tab anyway
              </Button>
              <Button
                type="button"
                onClick={() => { onActivateTab?.(preferred.tabId) }}
                disabled={busy}
              >
                {preferred.current ? 'stay here' : 'go to tab'}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={() => void submit({ forceNewTab: true })}
              disabled={busy || value.trim() === ''}
            >
              {pendingCreatePath ? 'create & open' : 'new session'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// ResumeSection — scrollable list of previous sessions for the typed cwd
// ---------------------------------------------------------------------------

function ResumeSection({
  resolvedPath,
  sessions,
  loading,
  onResume,
  disabled,
}: {
  resolvedPath: string | null
  sessions: Conversation[]
  loading: boolean
  onResume: (sessionId: string) => void | Promise<void>
  disabled: boolean
}) {
  if (!resolvedPath) return null

  return (
    <div className="flex-1 min-h-0 flex flex-col border-t border-border pt-3">
      <div className="text-[10px] uppercase tracking-[0.15em] text-muted font-medium mb-2 flex-shrink-0">
        resume
        {loading && (
          <span className="ml-2 text-ink-dim normal-case tracking-normal">
            loading…
          </span>
        )}
      </div>

      {sessions.length === 0 && !loading ? (
        <div className="text-[11px] text-muted italic py-2">
          no previous sessions recorded in this directory
        </div>
      ) : (
        <div className={`flex-1 min-h-0 overflow-auto -mx-2 ${disabled ? 'pointer-events-none opacity-50' : ''}`} role="listbox" aria-label="Previous sessions">
          {sessions.map((row, i) => (
            <ConversationRow
              key={`${row.provider}:${row.nativeId}`}
              row={row}
              index={i}
              selected={false}
              onHover={() => {}}
              onSelect={() => { if (row.available) void onResume(row.nativeId) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
