import { useMemo, useState } from 'react'

import type { Settings } from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES, type SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
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
    <div className="h-full min-h-0 min-w-0 bg-canvas">
      <div className="flex h-full min-h-0 min-w-0 border-t border-border">
        <SettingsSidebar
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          counts={categoryCounts}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
            <div>
              <div className="text-[13px] text-ink">Settings</div>
              <div className="mt-1 text-[11px] text-muted">
                Search, browse, and change application defaults.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="border border-border px-2.5 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink"
            >
              Close
            </button>
          </div>

          <SettingsSearch value={query} onChange={setQuery} />

          <SettingsList
            definitions={visibleDefinitions}
            settings={settings}
            selectedCategory={selectedCategory}
            onChange={onChange}
            actionContext={{
              workspace,
              settings,
              onChange,
              onReset,
              onClose,
            }}
          />
        </div>
      </div>
    </div>
  )
}
