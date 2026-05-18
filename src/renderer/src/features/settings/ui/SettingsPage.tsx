import { useEffect, useMemo, useRef, useState } from 'react'

import type { Settings } from '@renderer/app-state/settings/types'
import {
  CUSTOM_APPEARANCE_SCHEMA_JSON,
  type CustomAppearanceColors,
  parseCustomAppearanceJson,
  stringifyCustomAppearance,
} from '@renderer/app-state/settings/customAppearance'
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
  const textAreaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textAreaRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    try {
      onSave(parseCustomAppearanceJson(draft))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-appearance-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6 py-6"
    >
      <div className="flex h-full max-h-[760px] w-full max-w-4xl flex-col border border-border bg-canvas">
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <div>
            <div id="custom-appearance-title" className="text-[13px] text-ink">
              Custom Appearance
            </div>
            <div className="mt-1 text-[11px] text-muted">
              Define the application color tokens as validated JSON.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView(view === 'json' ? 'schema' : 'json')}
              className="border border-border px-2.5 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink"
            >
              {view === 'json' ? 'Show Schema' : 'Show JSON'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="border border-border px-2.5 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-4 py-4">
          {view === 'json' ? (
            <textarea
              ref={textAreaRef}
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                setError(null)
              }}
              spellCheck={false}
              className="h-full min-h-[420px] w-full resize-none border border-border bg-code-bg px-3 py-3 font-code text-[12px] leading-5 text-code-ink outline-none focus:border-accent"
            />
          ) : (
            <pre className="h-full min-h-[420px] overflow-auto border border-border bg-code-bg px-3 py-3 text-[12px] leading-5 text-code-ink">
              {CUSTOM_APPEARANCE_SCHEMA_JSON}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-surface px-4 py-3">
          <div className="min-w-0 text-[11px] text-danger">{error ?? ''}</div>
          <button
            type="button"
            onClick={save}
            className="border border-accent bg-accent px-3 py-2 text-[12px] text-accent-fg"
          >
            Save Custom Appearance
          </button>
        </div>
      </div>
    </div>
  )
}
