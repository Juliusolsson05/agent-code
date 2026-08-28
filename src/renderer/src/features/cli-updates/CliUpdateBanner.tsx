import { useMemo, useState } from 'react'

import type { CliUpdateKind, CliUpdateState } from '@shared/types/cliUpdate.js'
import { dismissKey, useCliUpdateStore } from '@renderer/features/cli-updates/store'

// Renderer-side banner for the CLI auto-updater.
//
// Sits just above the tab bar, in the same slot as RestoreBanner. That
// slot is explicitly documented as "for durable degraded state" — the
// exact shape of "your CLI is currently updating" and "your CLI update
// failed". Toasts are the wrong primitive here: an updating banner needs
// to persist for the ~30 s the command takes, and a failure banner needs
// to persist until the user dismisses or fixes it.
//
// Rendering rules (per CLI, folded together into one banner row):
//   - `updating`: subtle info tone ("Updating <cli>…"). One line.
//   - `failed`: sticky warning tone with a [View log] action AND an
//     inline info button that expands common-cause hints (double
//     installs, PATH shadowing) without leaving the app.
//   - `notify`: info tone with an [Update now] action that dispatches
//     cliUpdatesUpdateNow — a one-shot update that leaves the persisted
//     behavior preference untouched.
//   - `updated`: momentary success (up to a few seconds), only for
//     minor/major severity — patch updates are silent to avoid nagging.
//   - Everything else (idle/up-to-date/deferred): silent.
//
// Every renderable state has a dismiss X. Dismissal is renderer-only,
// identity-keyed (see store.ts::dismissKey) so a re-emit of the same
// underlying situation doesn't resurrect the banner, and NOT persisted
// across restarts — the next launch's fresh probe gets to speak again.

type BannerEntry = {
  tone: 'info' | 'warning' | 'success'
  text: string
  action?: { label: string; onClick: () => void }
  // Rendered next to the action as a tiny info button. When present,
  // the banner shows an expandable diagnostic hint. Only failed states
  // set this today; other states don't need the extra context.
  hint?: string
  // Some states are transient work in progress (updating). Making them
  // dismissible would hide an in-flight operation the user needs to
  // know is running. `undismissable: true` suppresses the X button but
  // the banner is still rendered.
  undismissable?: boolean
}

function describeState(cli: CliUpdateKind, state: CliUpdateState): BannerEntry | null {
  const label = cli === 'claude' ? 'Claude Code' : 'Codex'
  switch (state.kind) {
    case 'updating':
      return {
        tone: 'info',
        text: `Updating ${label} ${state.from} → ${state.to}…`,
        // In-flight — closing this while the update is spawning would
        // hide the reason a session-spawn might be blocked. Let it live
        // until the transition to updated/failed.
        undismissable: true,
      }
    case 'updated':
      // Silent for patches — the whole point of running the update
      // ourselves is that patch bumps should feel invisible. Minor and
      // major bumps get a brief note so the user knows something
      // meaningful changed under them.
      if (state.severity === 'patch') return null
      return {
        tone: 'success',
        text: `${label} updated to ${state.to}.`,
      }
    case 'failed': {
      const reasonHint =
        state.reason === 'timeout'
          ? 'timed out'
          : state.reason === 'version-unchanged'
            ? 'command reported success but the version did not change'
            : state.reason === 'network'
              ? 'could not reach the registry'
              : state.reason === 'unparseable-version'
                ? `--version output was unrecognizable`
                : 'command failed'
      const methodHint =
        state.installMethod === 'unknown' ? '' : ` (via ${state.installMethod})`
      // Common-cause hint. The version-unchanged branch is the one users
      // hit in practice — usually a duplicate install where the update
      // landed on one binary and PATH resolves to another. The log now
      // auto-appends `which -a <cli>` output (see
      // cliUpdateOrchestrator.ts::appendDiagnostics) so the log itself
      // often contains the smoking gun. This hint text points users
      // there so they don't just close the banner and move on.
      const hint =
        state.reason === 'version-unchanged'
          ? "This usually means more than one copy of the CLI is on PATH. The update landed on one install, but PATH resolves to another. Open the log — it now includes 'which -a' output showing every copy. Remove all but one."
          : state.reason === 'command-failed'
            ? 'The package manager rejected the update. The log has the raw stdout/stderr. Common causes: EACCES on an npm prefix you do not own (do not sudo), a stale Homebrew tap, or a locked binary on Windows.'
            : state.reason === 'timeout'
              ? 'The update command ran for 120 seconds without finishing. Usually it stopped on an interactive prompt (brew confirm, npm audit, or a similar dialog) that we cannot answer from the background.'
              : state.reason === 'network'
                ? 'Could not reach the registry to check the latest version. Check your network, then try again from Settings.'
                : undefined
      return {
        tone: 'warning',
        text: `${label} auto-update failed${methodHint} — ${reasonHint}. Wanted ${state.wantedLatest}, still at ${state.from}.`,
        action: {
          label: 'View log',
          onClick: () => {
            void window.api.cliUpdatesOpenLog(state.logPath)
          },
        },
        hint,
      }
    }
    case 'notify':
      return {
        tone: 'info',
        text: `${label} ${state.installed} → ${state.latest} available.`,
        action: {
          label: 'Update now',
          onClick: () => {
            // One-shot update: bypasses the automatic/notify/off
            // preference for this click only, leaving the persisted
            // behavior untouched.
            void window.api.cliUpdatesUpdateNow(cli)
          },
        },
      }
    case 'idle':
    case 'up-to-date':
    case 'deferred':
    default:
      return null
  }
}

export function CliUpdateBanner() {
  const snapshot = useCliUpdateStore(state => state.snapshot)
  const dismissed = useCliUpdateStore(state => state.dismissed)
  const dismiss = useCliUpdateStore(state => state.dismiss)

  const entries = useMemo(() => {
    const claudeEntry = describeState('claude', snapshot.claude)
    const codexEntry = describeState('codex', snapshot.codex)
    return (
      [
        { cli: 'claude' as const, key: dismissKey('claude', snapshot.claude), entry: claudeEntry },
        { cli: 'codex' as const, key: dismissKey('codex', snapshot.codex), entry: codexEntry },
      ]
        // Filter out silent states AND anything the user has dismissed.
        // The dismiss key is derived from state identity, not timestamp
        // — a re-emit of the same identity keeps the dismissal intact.
        .filter(row => row.entry !== null && !dismissed.has(row.key))
    ) as Array<{ cli: CliUpdateKind; key: string; entry: BannerEntry }>
  }, [snapshot.claude, snapshot.codex, dismissed])

  if (entries.length === 0) return null
  return (
    <div className="flex-shrink-0">
      {entries.map(({ cli, key, entry }) => (
        <BannerRow key={key} cli={cli} dismissKey={key} entry={entry} onDismiss={dismiss} />
      ))}
    </div>
  )
}

function BannerRow({
  cli: _cli,
  dismissKey: key,
  entry,
  onDismiss,
}: {
  cli: CliUpdateKind
  dismissKey: string
  entry: BannerEntry
  onDismiss: (key: string) => void
}) {
  const [hintOpen, setHintOpen] = useState(false)
  const toneClasses =
    // Uses the semantic tokens from #520 (warning-*, info-*, success-*)
    // so custom-appearance JSON overrides theme correctly.
    entry.tone === 'warning'
      ? 'border-warning bg-warning-soft text-warning'
      : entry.tone === 'success'
        ? 'border-success bg-success-soft text-success'
        : 'border-info bg-info-soft text-info'
  return (
    <div
      role="status"
      className={`border-b text-[11px] leading-snug font-code ${toneClasses}`}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        <span className="font-semibold uppercase tracking-wide">
          {entry.tone === 'warning' ? 'CLI update' : 'CLI'}
        </span>
        <span className="flex-1 text-ink/90">{entry.text}</span>
        {entry.hint && (
          <button
            type="button"
            aria-expanded={hintOpen}
            aria-label={hintOpen ? 'Hide diagnostic hint' : 'Show diagnostic hint'}
            title={hintOpen ? 'Hide details' : 'Why did this fail?'}
            onClick={() => setHintOpen(open => !open)}
            className="rounded-control border border-current px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-current/10"
          >
            {hintOpen ? '?—' : '?'}
          </button>
        )}
        {entry.action && (
          <button
            type="button"
            onClick={entry.action.onClick}
            className="rounded-control border border-current px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-current/10"
          >
            {entry.action.label}
          </button>
        )}
        {!entry.undismissable && (
          <button
            type="button"
            onClick={() => onDismiss(key)}
            aria-label="Dismiss"
            title="Dismiss"
            // Text is a Unicode multiplication sign, not a plain `x`, so
            // it visually matches close icons in other Agent Code
            // surfaces (TabBar, PathPickerModal). Keeping the same
            // font-code class so glyph baseline lines up with the rest
            // of the row.
            className="rounded-control border border-current px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-current/10"
          >
            ×
          </button>
        )}
      </div>
      {entry.hint && hintOpen && (
        // Expanded hint text below the row. Not a modal — the user
        // needs to see both the banner and the hint at the same time so
        // "wait, WHICH CLI?" stays obvious. Rendered inside the same
        // colored container so it looks attached, not floating.
        <div className="border-t border-current/30 px-3 py-2 text-[10.5px] leading-relaxed text-ink/80">
          {entry.hint}
        </div>
      )}
    </div>
  )
}
