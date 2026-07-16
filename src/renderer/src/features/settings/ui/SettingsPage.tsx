import { useMemo, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import type { Settings } from '@renderer/app-state/settings/types'
import {
  CUSTOM_APPEARANCE_SCHEMA_JSON,
  parseCustomAppearanceJson,
  stringifyCustomAppearance,
} from '@renderer/app-state/settings/customAppearance'
import type { CustomAppearanceColors } from '@renderer/app-state/settings/customAppearance'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import type { SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
import { getSettingsRegistry, matchesSettingQuery } from '@renderer/features/settings/lib/settingsRegistry'
import { SettingsList } from '@renderer/features/settings/ui/SettingsList'
import { SettingsSearch } from '@renderer/features/settings/ui/SettingsSearch'
import { SettingsSidebar } from '@renderer/features/settings/ui/SettingsSidebar'

type Props = {
  onClose: () => void
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
}

export function SettingsPage({ onClose, workspace, settings, onChange, onReset }: Props) {
  const [query, setQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<SettingCategoryId | 'all'>('all')
  const [customAppearanceOpen, setCustomAppearanceOpen] = useState(false)

  const registry = useMemo(() => getSettingsRegistry(), [])
  const visibleDefinitions = useMemo(
    () =>
      registry.filter(definition => {
        if (selectedCategory !== 'all' && definition.category !== selectedCategory) return false
        return matchesSettingQuery(definition, query)
      }),
    [query, registry, selectedCategory],
  )

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: registry.length }
    for (const category of SETTING_CATEGORIES) {
      counts[category.id] = registry.filter(definition => definition.category === category.id).length
    }
    return counts
  }, [registry])

  return (
    <div
      {...{ [APP_INTERACTION_OWNER_ATTRIBUTE]: 'app' }}
      className="h-full min-h-0 min-w-0 bg-canvas"
    >
      <div className="flex h-full min-h-0 min-w-0 border-t border-panel-border">
        <SettingsSidebar
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          counts={categoryCounts}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-panel-border bg-panel-header-bg px-4 py-3">
            <div>
              <div className="text-[13px] text-ink">Settings</div>
              <div className="mt-1 text-[11px] text-muted">
                Search, browse, and change application defaults.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="border border-control-border bg-control-bg px-2.5 py-1.5 text-[11px] text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink"
            >
              Close
            </button>
          </div>

          <SettingsSearch value={query} onChange={setQuery} />

          <SettingsList
            definitions={visibleDefinitions}
            settings={settings}
            selectedCategory={selectedCategory}
            actionContext={{
              workspace,
              settings,
              onChange,
              onReset,
              onClose,
              openCustomAppearanceEditor: () => setCustomAppearanceOpen(true),
            }}
          />
        </div>
      </div>

      {customAppearanceOpen ? (
        <CustomAppearanceModal
          raw={settings.customAppearanceJson}
          onClose={() => setCustomAppearanceOpen(false)}
          onSave={parsed => {
            onChange({
              mode: 'custom',
              customAppearanceJson: stringifyCustomAppearance(parsed),
            })
            setCustomAppearanceOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function CustomAppearanceModal({
  raw,
  onClose,
  onSave,
}: {
  raw: string
  onClose: () => void
  onSave: (colors: CustomAppearanceColors) => void
}) {
  const [draft, setDraft] = useState(raw)
  const [view, setView] = useState<'json' | 'schema'>('json')
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    try {
      onSave(parseCustomAppearanceJson(draft))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="flex h-[calc(100vh-3rem)] max-h-[760px] w-[calc(100vw-3rem)] max-w-4xl flex-col border-popover-border bg-popover-bg p-0">
        <div className="flex items-center justify-between border-b border-panel-border bg-panel-header-bg px-4 py-3">
          <div>
            <DialogTitle>
              Custom Appearance
            </DialogTitle>
            <DialogDescription>
              Define the application color tokens as validated JSON.
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => setView(view === 'json' ? 'schema' : 'json')}
              variant="secondary"
              size="sm"
            >
              {view === 'json' ? 'Show Schema' : 'Show JSON'}
            </Button>
            <Button
              type="button"
              onClick={onClose}
              variant="secondary"
              size="sm"
            >
              Close
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-4 py-4">
          {view === 'json' ? (
            <Textarea
              autoFocus
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                setError(null)
              }}
              spellCheck={false}
              className="h-full min-h-[420px] resize-none bg-code-bg px-3 py-3 text-[12px] leading-5 text-code-ink"
            />
          ) : (
            <pre className="h-full min-h-[420px] overflow-auto border border-input-border bg-code-bg px-3 py-3 text-[12px] leading-5 text-code-ink">
              {CUSTOM_APPEARANCE_SCHEMA_JSON}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-panel-border bg-panel-header-bg px-4 py-3">
          <div className="min-w-0 text-[11px] text-danger">{error ?? ''}</div>
          <Button
            type="button"
            onClick={save}
          >
            Save Custom Appearance
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
