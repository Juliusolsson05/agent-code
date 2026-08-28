import type { Settings } from '@renderer/app-state/settings/types'
import type {
  SettingActionContext,
  SettingDefinition,
} from '@renderer/features/settings/lib/settingsRegistry'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import { HotkeyInput } from '@renderer/features/settings/ui/HotkeyInput'
import { MouseButtonInput } from '@renderer/features/settings/ui/MouseButtonInput'
import { CommandKeybindingsRow } from '@renderer/features/settings/ui/CommandKeybindingsRow'
import { settingMetadata } from '@renderer/features/settings/lib/settingsRegistry'
import { CliUpdateBehaviorRow } from '@renderer/features/cli-updates/CliUpdateBehaviorRow'
import { DictationApiKeyRow } from '@renderer/features/voice-dictation/DictationApiKeyRow'
import { DictationHistoryRow } from '@renderer/features/voice-dictation/DictationHistoryRow'
import { ThemePickerRow } from '@renderer/features/settings/ui/ThemePickerRow'
import { AgentCodeConventionsRow } from '@renderer/features/settings/ui/AgentCodeConventionsRow'
import { AgentCodeCustomSkillsRow } from '@renderer/features/settings/ui/AgentCodeCustomSkillsRow'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

// Settings rows are full-width, left-aligned, and two-line-capable, so they
// override Button's default size geometry. They do NOT override its colours —
// that is the whole point of routing them through the variant: the resting/
// hover control chrome now comes from one place, and follows the user's
// control-* appearance overrides for free.
//
// h-auto rather than a size: none of the fixed sizes fit a row whose height is
// set by its content.
//
// `rounded-none` cancels Button's `rounded-control` deliberately, and is the
// one place in the app where a control opts OUT of the corner system: these
// rows are stacked flush inside a bordered section, so they are STRUCTURE by
// hard rule 1 (styles.css) — rounding them would open a visible gap at every
// seam between adjacent rows. A control that has been reshaped into a
// full-bleed row stops being a control for radius purposes.
const SETTINGS_ROW_CLASS =
  'flex h-auto w-full items-center justify-between rounded-none px-3 py-2 text-left text-[12px]'

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
        <div className="rounded-slab border border-border px-4 py-4 text-[12px] text-muted">
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
          <section key={group.category.id} className="rounded-slab border border-border bg-canvas">
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
    <div className="border-b border-panel-border px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0">
          <div className="text-[12px] text-ink">{definition.title}</div>
          <div className="mt-1 text-[11px] leading-5 text-muted">{definition.description}</div>
        </div>

        <div className="w-full max-w-[420px] shrink-0">
          <SettingMetadataBadges definition={definition} />

          {control.type === 'toggle' ? (
            <Button
              variant="outline"
              onClick={() =>
                void control.onToggle(
                  context,
                  !control.getValue(settings),
                )
              }
              className={SETTINGS_ROW_CLASS}
            >
              <span>{control.getValue(settings) ? 'Enabled' : 'Disabled'}</span>
              <span
                className={`flex h-3.5 w-3.5 border ${
                  control.getValue(settings)
                        ? 'border-control-active-bg bg-control-active-bg'
                        : 'border-control-border-hover bg-transparent'
                }`}
              />
            </Button>
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
                    className={`rounded-control border px-3 py-2 text-left ${
                      active
                        ? 'border-control-active-bg bg-control-active-bg text-control-active-fg'
                        : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink'
                    }`}
                  >
                    <div className="text-[11px]">{option.label}</div>
                    {option.description ? (
                      <div className={`mt-1 text-[10px] ${active ? 'text-control-active-fg/80' : 'text-muted'}`}>
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

          {control.type === 'mouse-button' ? (
            <MouseButtonInput
              value={control.getValue(settings)}
              onChange={value => control.onChange(context, value)}
            />
          ) : null}

          {/* The variant ternary below switches on TONE, not on a
              pressed/selected state, so both arms are ordinary variants — this
              is not one of the toggles that has to keep a hand-rolled
              conditional class. */}
          {control.type === 'action' ? (
            <Button
              variant={control.tone === 'danger' ? 'destructive-outline' : 'outline'}
              onClick={() => void control.onTrigger(context)}
              className={cn(SETTINGS_ROW_CLASS, 'justify-start')}
            >
              {control.label}
            </Button>
          ) : null}

          {/* CLI auto-updater — the row owns its own subscription
              because the value lives in setup.json (main-owned), not
              in the renderer Settings store. See
              features/cli-updates/CliUpdateBehaviorRow.tsx. */}
          {control.type === 'command-keybindings' ? <CommandKeybindingsRow /> : null}

          {control.type === 'cli-update-behavior' ? <CliUpdateBehaviorRow /> : null}

          {/* Voice-dictation API key — same self-subscribing marker-row
              pattern as CLI updates: the ciphertext lives in
              safeStorage-backed main state, so the row owns the IPC
              round-trip. See features/voice-dictation/DictationApiKeyRow.tsx. */}
          {control.type === 'dictation-api-key' ? <DictationApiKeyRow /> : null}

          {/* Same marker-row rationale: the transcripts and lifetime totals
              live in a main-owned JSON store, not in Settings. */}
          {control.type === 'dictation-history' ? <DictationHistoryRow /> : null}

          {control.type === 'agent-code-conventions' ? <AgentCodeConventionsRow /> : null}

          {control.type === 'agent-code-custom-skills' ? <AgentCodeCustomSkillsRow /> : null}

          {/* Theme grid — built-ins and saved themes in one list, with the
              create/edit/delete affordances the generic select can't carry.
              See features/settings/ui/ThemePickerRow.tsx. */}
          {control.type === 'theme-picker' ? (
            <ThemePickerRow
              settings={settings}
              onSelect={mode => actionContext.onChange({ mode })}
              onCreate={() => actionContext.openThemeEditor(null)}
              onEdit={theme => actionContext.openThemeEditor(theme.id)}
              onDelete={theme => actionContext.deleteSavedTheme(theme.id)}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Small badges stating what a setting actually changes and when.
 *
 * Only the NON-DEFAULT facts are rendered. Showing "app / immediate /
 * settings" on the thirty rows where that is already the obvious reading
 * would bury the handful where it is not — and those are the whole point:
 * the row that reloads live agents, the one that only affects a fresh
 * install, the one whose value lives in the keychain and survives Reset
 * Settings.
 */
function SettingMetadataBadges({ definition }: { definition: SettingDefinition }) {
  const meta = settingMetadata(definition)
  const badges: string[] = []
  if (meta.scope !== 'app') badges.push(SCOPE_LABELS[meta.scope])
  if (meta.apply !== 'immediate') badges.push(APPLY_LABELS[meta.apply])
  if (meta.storage !== 'settings') badges.push(STORAGE_LABELS[meta.storage])
  if (meta.status) badges.push(STATUS_LABELS[meta.status])
  if (badges.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {badges.map(badge => (
        <span
          key={badge}
          className="rounded-chip border border-panel-border bg-panel-elevated-bg px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted"
        >
          {badge}
        </span>
      ))}
    </div>
  )
}

const SCOPE_LABELS = {
  app: 'App',
  project: 'Project',
  'session-default': 'New sessions',
  'fresh-install': 'Fresh install only',
} as const

const APPLY_LABELS = {
  immediate: 'Immediate',
  'new-session': 'Next session',
  'reload-live-sessions': 'Reloads live agents',
  'restart-required': 'Restart required',
} as const

const STORAGE_LABELS = {
  settings: 'Settings',
  workspace: 'Workspace',
  setup: 'App setup',
  keychain: 'Keychain',
  'external-files': 'Files on disk',
} as const

const STATUS_LABELS = {
  experimental: 'Experimental',
  dangerous: 'Dangerous',
  developer: 'Developer',
} as const
