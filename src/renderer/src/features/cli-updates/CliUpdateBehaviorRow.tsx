import type { CliUpdateBehavior } from '@shared/types/cliUpdate.js'
import { setCliUpdateBehavior, useCliUpdateStore } from '@renderer/features/cli-updates/store'

// Settings row for CLI auto-update behavior.
//
// WHY this component owns its own subscription instead of being driven
// through the existing settings registry `select` control:
//   The registry's select control reads from the persisted `Settings`
//   store (renderer-owned, in localStorage) and writes back via
//   onChange. The CLI-update behavior lives in setup.json (main-owned)
//   for the same reason skippedOptionalTools does — no need to bump the
//   renderer store version when we tweak update policy, and the main
//   process needs the value before the renderer even connects. Piping
//   it through the Settings type would require a store version bump and
//   would mean two places persist the same value.
//
//   So this row subscribes to useCliUpdateStore directly. The registry
//   emits a marker (`type: 'cli-update-behavior'`) so the SettingsList
//   view knows to render <CliUpdateBehaviorRow /> instead of a stock
//   select — see settingsRegistry.ts and SettingsList.tsx.

const OPTIONS: Array<{ value: CliUpdateBehavior; label: string; description: string }> = [
  {
    value: 'automatic',
    label: 'Automatic',
    description:
      'Update Claude Code and Codex in the background on every launch when a new stable version is available.',
  },
  {
    value: 'notify',
    label: 'Notify only',
    description: 'Check versions on launch and show a banner, but do not run the update automatically.',
  },
  {
    value: 'off',
    label: 'Off',
    description:
      'Do not check or update. Each CLI still runs its own built-in update flow, which Agent Code will not intercept.',
  },
]

export function CliUpdateBehaviorRow() {
  // Subscribe to just the behavior slice — the banner state churn (updating
  // → updated etc.) should not re-render this row.
  const behavior = useCliUpdateStore(state => state.snapshot.behavior)
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
      {OPTIONS.map(option => {
        const active = behavior === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setCliUpdateBehavior(option.value)}
            className={
              'border px-3 py-2 text-left ' +
              (active
                ? 'border-control-active-bg bg-control-active-bg text-control-active-fg'
                : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink')
            }
          >
            <div className="text-[11px]">{option.label}</div>
            <div className={`mt-1 text-[10px] ${active ? 'text-control-active-fg/80' : 'text-muted'}`}>
              {option.description}
            </div>
          </button>
        )
      })}
    </div>
  )
}
