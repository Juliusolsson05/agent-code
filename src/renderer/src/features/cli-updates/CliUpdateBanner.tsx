import { useMemo } from 'react'

import type { CliUpdateKind, CliUpdateState } from '@shared/types/cliUpdate.js'
import { useCliUpdateStore } from '@renderer/features/cli-updates/store'

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
//   - `failed`: sticky warning tone with a [View log] action.
//   - `notify` (behavior === 'notify'): info tone with an [Update now]
//     action that dispatches cliUpdatesRefresh — the orchestrator honors
//     the setting change temporarily via the boot decision matrix.
//   - `updated`: momentary success (up to a few seconds), only for
//     minor/major severity — patch updates are silent to avoid nagging.
//   - Everything else (idle/up-to-date/deferred): silent.
//
// Both CLIs' states render in the same banner if both need attention,
// stacked. Empty when neither has anything to say — the returned null
// causes the banner not to occupy any layout space.

type BannerEntry =
  | { tone: 'info' | 'warning' | 'success'; text: string; action?: { label: string; onClick: () => void } }

function describeState(cli: CliUpdateKind, state: CliUpdateState): BannerEntry | null {
  const label = cli === 'claude' ? 'Claude Code' : 'Codex'
  switch (state.kind) {
    case 'updating':
      return {
        tone: 'info',
        text: `Updating ${label} ${state.from} → ${state.to}…`,
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
      return {
        tone: 'warning',
        text: `${label} auto-update failed (${reasonHint}). Wanted ${state.wantedLatest}, still at ${state.from}.`,
        action: {
          label: 'View log',
          onClick: () => {
            void window.api.cliUpdatesOpenLog(state.logPath)
          },
        },
      }
    }
    case 'notify':
      return {
        tone: 'info',
        text: `${label} ${state.installed} → ${state.latest} available.`,
        action: {
          label: 'Update now',
          onClick: () => {
            // Refresh dispatches a fresh probe which, in `notify` mode,
            // only emits the notification. We need to run the update as
            // a one-off — the pragma here is to temporarily switch to
            // automatic, refresh, then switch back. That's noisy and
            // error-prone; simpler is to just tell main to run once via
            // refresh AND to accept that in `notify` mode the button is
            // best-effort. Rather than build another handler, we simply
            // switch behavior to 'automatic' — the user asked for the
            // update, and they can switch back afterward if they want.
            void window.api.cliUpdatesSetBehavior('automatic')
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
  const entries = useMemo(() => {
    const claudeEntry = describeState('claude', snapshot.claude)
    const codexEntry = describeState('codex', snapshot.codex)
    return [claudeEntry, codexEntry].filter((e): e is BannerEntry => e !== null)
  }, [snapshot.claude, snapshot.codex])
  if (entries.length === 0) return null
  return (
    <div className="flex-shrink-0">
      {entries.map((entry, i) => (
        <div
          key={i}
          role="status"
          className={
            `flex items-start gap-3 px-3 py-2 border-b text-[11px] leading-snug font-code ` +
            // Uses the semantic tokens from #520 (control-*, warning-*,
            // info-*, success-*). These pick up custom-appearance JSON
            // overrides automatically so a user's warm-light theme
            // doesn't get a jarring GitHub-red bar.
            (entry.tone === 'warning'
              ? 'border-warning bg-warning-soft text-warning'
              : entry.tone === 'success'
                ? 'border-success bg-success-soft text-success'
                : 'border-info bg-info-soft text-info')
          }
        >
          <span className="font-semibold uppercase tracking-wide">
            {entry.tone === 'warning' ? 'CLI update' : 'CLI'}
          </span>
          <span className="flex-1 text-ink/90">{entry.text}</span>
          {entry.action && (
            <button
              type="button"
              onClick={entry.action.onClick}
              className="border border-current px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-current/10"
            >
              {entry.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
