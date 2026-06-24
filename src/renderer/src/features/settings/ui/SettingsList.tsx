import type { Settings } from '@renderer/app-state/settings/types'
import type {
  SettingActionContext,
  SettingDefinition,
} from '@renderer/features/settings/lib/settingsRegistry'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import { HotkeyInput } from '@renderer/features/settings/ui/HotkeyInput'

type Props = {
  definitions: SettingDefinition[]
  settings: Settings
  selectedCategory: string
  actionContext: SettingActionContext
}

export function SettingsList({
  definitions,
  settings,
  selectedCategory,
  actionContext,
}: Props) {
  if (definitions.length === 0) {
    return (
      <div className="flex-1 px-4 py-6">
        <div className="border border-border px-4 py-4 text-[12px] text-muted">
          No settings matched this filter.
        </div>
      </div>
    )
  }

  const grouped =
    selectedCategory === 'all'
      ? SETTING_CATEGORIES.map(category => ({
          category,
          items: definitions.filter(definition => definition.category === category.id),
        })).filter(group => group.items.length > 0)
      : [
          {
            category:
              SETTING_CATEGORIES.find(category => category.id === selectedCategory) ??
              SETTING_CATEGORIES[0],
            items: definitions,
          },
        ]

  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {grouped.map(group => (
          <section key={group.category.id} className="border border-border bg-canvas">
            <div className="border-b border-border px-4 py-3">
              <div className="text-[13px] text-ink">{group.category.label}</div>
              <div className="mt-1 text-[11px] leading-5 text-muted">
                {group.category.description}
              </div>
            </div>

            <div className="flex flex-col">
              {group.items.map(definition => (
                <SettingRow
                  key={definition.id}
                  definition={definition}
                  settings={settings}
                  actionContext={actionContext}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function SettingRow({
  definition,
  settings,
  actionContext,
}: {
  definition: SettingDefinition
  settings: Settings
  actionContext: SettingActionContext
}) {
  const context = { ...actionContext, settings }
  const control = definition.control

  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0">
          <div className="text-[12px] text-ink">{definition.title}</div>
          <div className="mt-1 text-[11px] leading-5 text-muted">{definition.description}</div>
        </div>

        <div className="w-full max-w-[420px] shrink-0">
          {control.type === 'toggle' ? (
            <button
              type="button"
              onClick={() =>
                void control.onToggle(
                  context,
                  !control.getValue(settings),
                )
              }
              className="flex w-full items-center justify-between border border-border px-3 py-2 text-left text-[12px] text-ink-dim hover:border-border-hi hover:text-ink"
            >
              <span>{control.getValue(settings) ? 'Enabled' : 'Disabled'}</span>
              <span
                className={`flex h-3.5 w-3.5 border ${
                  control.getValue(settings)
                    ? 'border-accent bg-accent'
                    : 'border-border-hi bg-transparent'
                }`}
              />
            </button>
          ) : null}

          {control.type === 'select' ? (
            <div
              className="grid gap-1.5"
              style={{
                gridTemplateColumns: `repeat(${control.columns ?? 1}, minmax(0, 1fr))`,
              }}
            >
              {control.options.map(option => {
                const active = control.getValue(settings) === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => void control.onSelect(context, option.value)}
                    className={`border px-3 py-2 text-left ${
                      active
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border text-ink-dim hover:border-border-hi hover:text-ink'
                    }`}
                  >
                    <div className="text-[11px]">{option.label}</div>
                    {option.description ? (
                      <div className={`mt-1 text-[10px] ${active ? 'text-accent-fg/80' : 'text-muted'}`}>
                        {option.description}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          {control.type === 'hotkey' ? (
            <HotkeyInput
              value={control.getValue(settings)}
              onChange={value => control.onChange(context, value)}
            />
          ) : null}

          {control.type === 'action' ? (
            <button
              type="button"
              onClick={() => void control.onTrigger(context)}
              className={`w-full border px-3 py-2 text-left text-[12px] ${
                control.tone === 'danger'
                  ? 'border-danger text-danger hover:bg-danger/10'
                  : 'border-border text-ink-dim hover:border-border-hi hover:text-ink'
              }`}
            >
              {control.label}
            </button>
          ) : null}

          {/* Command-visibility control: one toggle row per command plus a
              reset action. Purely presentational — every state transition
              flows out through the control's callbacks (which patch the
              sparse override map in settings); this branch never owns or
              derives visibility itself. The toggle row reuses the same
              border/checkbox styling as the `toggle` control above so the
              long list reads as a single coherent group. */}
          {control.type === 'command-visibility' ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex max-h-[320px] flex-col gap-1 overflow-auto">
                {control.commands.map(command => {
                  const visible = control.isVisible(settings, command)
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onClick={() => control.onToggleCommand(context, command, !visible)}
                      className="flex w-full items-center justify-between border border-border px-3 py-2 text-left text-[12px] text-ink-dim hover:border-border-hi hover:text-ink"
                    >
                      <span className="min-w-0 truncate">{command.title}</span>
                      <span
                        className={`ml-3 flex h-3.5 w-3.5 shrink-0 border ${
                          visible
                            ? 'border-accent bg-accent'
                            : 'border-border-hi bg-transparent'
                        }`}
                      />
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => control.onResetVisibility(context)}
                className="w-full border border-border px-3 py-2 text-left text-[12px] text-ink-dim hover:border-border-hi hover:text-ink"
              >
                Reset command visibility
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
