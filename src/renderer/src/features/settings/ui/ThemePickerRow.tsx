import { THEME_MODES } from '@renderer/app-state/settings/types'
import type { Settings, ThemeModeValue } from '@renderer/app-state/settings/types'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'

type Props = {
  settings: Settings
  onSelect: (mode: ThemeModeValue) => void
  onCreate: () => void
  onEdit: (theme: SavedTheme) => void
  onDelete: (theme: SavedTheme) => void
}

// WHY saved themes sit in the same grid as built-ins rather than in a separate
// "My Themes" section: a saved theme IS a theme, and segregating user content
// into a second-class list below the "real" options is how a feature ends up
// unused. There is direct precedent in this codebase — the command palette
// lists custom prompt templates alongside built-in ones, tagged with their
// scope and carrying inline Edit/Delete buttons. Matching that shape gives the
// app one mental model for "built-in vs mine" instead of two.
//
// WHY this is a marker row rather than the generic `select` control: that
// control renders uniform value cells with no room for per-cell actions, and
// the trailing "+ New theme…" cell is an action rather than a value. Same
// escape hatch cli-update-behavior and dictation-api-key already use.
export function ThemePickerRow({ settings, onSelect, onCreate, onEdit, onDelete }: Props) {
  return (
    // gap-px over a bg-panel-border parent draws the grid lines as gaps rather
    // than per-cell borders, which keeps the double-border seams out and
    // respects the codebase's no-border-radius rule.
    <div className="grid grid-cols-2 gap-px border border-panel-border bg-panel-border">
      {THEME_MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          onClick={() => onSelect(mode.id)}
          className={`flex items-center justify-between gap-2 px-3 py-2 text-left text-[12px] ${
            settings.mode === mode.id
              ? 'bg-row-selected-bg text-row-selected-fg'
              : 'bg-row-bg text-ink-dim hover:bg-row-hover-bg'
          }`}
        >
          <span className="min-w-0 truncate">{mode.label}</span>
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
            {mode.family}
          </span>
        </button>
      ))}

      {settings.savedThemes.map(theme => (
        <div
          key={theme.id}
          className={`group flex items-center justify-between gap-2 px-3 py-2 text-[12px] ${
            settings.mode === theme.id
              ? 'bg-row-selected-bg text-row-selected-fg'
              : 'bg-row-bg text-ink-dim hover:bg-row-hover-bg'
          }`}
        >
          <button
            type="button"
            onClick={() => onSelect(theme.id)}
            className="min-w-0 flex-1 truncate text-left"
          >
            {theme.name}
          </button>
          {/* Actions replace the CUSTOM tag on hover so the resting grid stays
              quiet. group-hover alone would strand keyboard users, so
              focus-within reveals them too. */}
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted group-hover:hidden group-focus-within:hidden">
            custom
          </span>
          <span className="hidden flex-shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
            <button
              type="button"
              onClick={() => onEdit(theme)}
              className="border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDelete(theme)}
              className="border border-danger-border bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger"
            >
              Delete
            </button>
          </span>
        </div>
      ))}

      {/* Always the last cell, so the grid stays a filled rectangle as themes
          are added instead of leaving a hole somewhere in the middle. */}
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center bg-row-bg px-3 py-2 text-left text-[12px] text-muted hover:bg-row-hover-bg hover:text-ink"
      >
        + New theme…
      </button>
    </div>
  )
}
