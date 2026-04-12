import { useEffect, useRef, useState } from 'react'

import { PathInput } from '../components/PathInput'

// Duplicate of the SessionInfo shape preload exposes. Inlined here so
// the renderer's tsconfig doesn't need to reach across into src/preload
// — the renderer include set covers only .tsx under src/renderer + the
// preload .d.ts, and the .d.ts only declares window.api, not types.
type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}

// PathPickerModal — modal that asks the user for a working directory
// when they press ⌘T (or click the + button in the tab bar).
//
// Responsibilities:
//   - Let the user type a path (with completion via PathInput).
//   - Validate the path via window.api.expandCwd on submit/interaction.
//   - Show the recent sessions recorded in that cwd (read from
//     ~/.claude/projects/<sanitized-cwd>/) so the user can RESUME an
//     existing session instead of starting fresh.
//   - On open: start a fresh session in the validated cwd.
//   - On resume click: spawn with --resume <sessionId>.
//
// All the completion machinery lives in <PathInput>; this file owns
// the modal chrome, session list fetching, and the submit → validate
// → spawn wiring.

export type AgentProvider = 'claude' | 'codex'

type Props = {
  open: boolean
  defaultValue?: string
  onCancel: () => void
  /** Called when the user opens a brand-new session for `cwd`.
   *  Now carries the selected provider so App knows which kind to spawn. */
  onAccept: (expandedPath: string, provider: AgentProvider) => void | Promise<void>
  /** Called when the user picks a previous session to resume. */
  onResume: (expandedPath: string, sessionId: string) => void | Promise<void>
}

export function PathPickerModal({
  open,
  defaultValue = '',
  onCancel,
  onAccept,
  onResume,
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Resume list state. We eagerly refresh the list whenever the path
  // changes and resolves to a valid directory — gives the user live
  // feedback as they type (e.g. "ah, no recorded sessions in this
  // folder yet, I'll start fresh").
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  // Latest resolved absolute path. Tracked separately from `value` so
  // actions use the validated form rather than re-running expand.
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  // Debounce token for the session list refresh — see the effect below.
  const reqVersion = useRef(0)

  // Reset on open so a stale error / value from a previous attempt
  // doesn't carry over.
  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setError(null)
    setBusy(false)
    setSessions([])
    setSessionsLoading(false)
    setResolvedPath(null)
  }, [open, defaultValue])

  // Refresh the sessions list whenever the typed path changes. Run
  // expandCwd to both validate the path AND get the absolute form we
  // use as the key for listSessionsForCwd. Debounced 150ms so we don't
  // hammer main on every keystroke.
  useEffect(() => {
    if (!open) return
    const v = ++reqVersion.current
    const t = setTimeout(async () => {
      const result = await window.api.expandCwd(value)
      if (v !== reqVersion.current) return
      if (!result.ok) {
        // Don't surface the error as a modal-level error just because
        // the user is mid-typing. Only clear the session list and
        // resolved path so the list doesn't lie.
        setResolvedPath(null)
        setSessions([])
        return
      }
      setResolvedPath(result.path)
      setSessionsLoading(true)
      const list = await window.api.listSessionsForCwd(result.path, 20)
      if (v !== reqVersion.current) return
      setSessions(list)
      setSessionsLoading(false)
    }, 150)
    return () => clearTimeout(t)
  }, [value, open])

  if (!open) return null

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await window.api.expandCwd(value)
    if (!result.ok) {
      setError(result.error)
      setBusy(false)
      return
    }
    await onAccept(result.path)
    setBusy(false)
  }

  const resume = async (sessionId: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    // Use the already-validated path if we have one; fall back to
    // re-validating just in case the user typed something new since
    // the last debounce.
    let path = resolvedPath
    if (!path) {
      const result = await window.api.expandCwd(value)
      if (!result.ok) {
        setError(result.error)
        setBusy(false)
        return
      }
      path = result.path
    }
    await onResume(path, sessionId)
    setBusy(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="
        modal-fade
        fixed inset-0 z-[1000]
        flex items-center justify-center
        bg-canvas/80 backdrop-blur-sm
      "
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="
          modal-pop
          w-[620px] max-w-[calc(100vw-64px)]
          bg-surface border border-border-hi
          p-6
          max-h-[80vh] flex flex-col
        "
      >
        <div className="text-[13px] font-semibold text-ink mb-4 flex-shrink-0">
          New tab — working directory
        </div>

        <div className="relative mb-2 flex-shrink-0">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-accent text-[12px] pointer-events-none select-none z-10">
            ❯
          </div>
          <PathInput
            value={value}
            onChange={next => {
              setValue(next)
              if (error) setError(null)
            }}
            onSubmit={() => void submit()}
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

        {/* Error slot */}
        <div className="min-h-[16px] text-[11px] mb-3 flex-shrink-0">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <span className="text-muted">
              tab completes · ↑↓ to browse · enter to open · esc to cancel
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

        <div className="flex justify-end gap-2 mt-4 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="
              px-4 py-1.5 text-[12px]
              bg-transparent text-ink-dim
              border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-120
              disabled:opacity-50
            "
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || value.trim() === ''}
            className="
              px-4 py-1.5 text-[12px] font-semibold
              bg-accent text-accent-fg
              border border-accent
              hover:brightness-110
              transition-all duration-120
              disabled:opacity-50
            "
          >
            new session
          </button>
        </div>
      </div>
    </div>
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
  sessions: SessionInfo[]
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
        <div className="flex-1 min-h-0 overflow-auto -mx-2">
          {sessions.map(s => (
            <ResumeRow
              key={s.sessionId}
              session={s}
              disabled={disabled}
              onClick={() => void onResume(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ResumeRow({
  session,
  disabled,
  onClick,
}: {
  session: SessionInfo
  disabled: boolean
  onClick: () => void
}) {
  const age = relativeTime(session.lastModified)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="
        group w-full
        flex items-baseline gap-3
        text-left
        px-2 py-2
        hover:bg-surface-hi
        transition-colors duration-120
        disabled:opacity-50
        border-b border-border last:border-b-0
      "
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-ink truncate">{session.summary}</div>
        <div className="text-[10px] text-muted mt-0.5 flex items-center gap-2">
          <span className="font-code">{session.sessionId.slice(0, 8)}</span>
          {session.gitBranch && (
            <>
              <span className="opacity-40">·</span>
              <span className="truncate max-w-[140px]">{session.gitBranch}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex-shrink-0 text-[10px] text-muted tabular-nums">
        {age}
      </div>
    </button>
  )
}

/**
 * Render a timestamp as a short relative string: `3m`, `2h`, `4d`,
 * `3w`. Matches the vibe of git log / GitHub timestamps. Used in the
 * resume picker where exact dates would cost space and not add info.
 */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 0) return 'now'
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.floor(d / 365)
  return `${y}y ago`
}
