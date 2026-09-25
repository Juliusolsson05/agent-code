import { useEffect, useMemo, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
import { sectionCycleTarget } from '@renderer/lib/sectionCycle'
import { Textarea } from '@renderer/components/ui/textarea'
import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'
import {
  CUSTOM_APPEARANCE_SCHEMA_JSON,
  parseCustomAppearanceJson,
  stringifyCustomAppearance,
} from '@renderer/app-state/settings/customAppearance'
import {
  SAVED_THEME_NAME_MAX,
  createSavedTheme,
  findSavedTheme,
  readAppliedAppearance,
} from '@renderer/app-state/settings/savedThemes'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import type { SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
import { getSettingsRegistry, matchesSettingQuery } from '@renderer/features/settings/lib/settingsRegistry'
import { SettingsList } from '@renderer/features/settings/ui/SettingsList'
import { SettingsSearch } from '@renderer/features/settings/ui/SettingsSearch'
import { SettingsSidebar } from '@renderer/features/settings/ui/SettingsSidebar'
import { useAppStore } from '@renderer/app-state/store'

function validCategory(value: string | null): SettingCategoryId | 'all' {
  return SETTING_CATEGORIES.find(category => category.id === value)?.id ?? 'all'
}

type Props = {
  onClose: () => void
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
}

export function SettingsPage({ onClose, workspace, settings, onChange, onReset }: Props) {
  const [query, setQuery] = useState('')
  // A deep link (openSettingsPage('mcp')) picks the starting category. Read
  // once at mount AND followed while open, so "MCP Servers" invoked with
  // Settings already showing another category still lands on MCP.
  const requestedCategory = useAppStore(state => state.settingsPageCategory)
  // The request counter, not the category string, drives the effect: running
  // "MCP Servers" twice with a sidebar click in between asks for the same
  // string twice, and only a changed dependency re-applies it (review round 1).
  const request = useAppStore(state => state.settingsPageRequest)
  const [selectedCategory, setSelectedCategory] = useState<SettingCategoryId | 'all'>(
    () => validCategory(requestedCategory),
  )
  useEffect(() => {
    if (requestedCategory) setSelectedCategory(validCategory(requestedCategory))
  }, [requestedCategory, request])
  // null           → editor closed
  // { id: null }   → creating, seeded from the currently applied appearance
  // { id: '...' }  → editing that saved theme
  //
  // WHY a target object rather than the old `customAppearanceOpen` boolean:
  // there is now more than one thing the editor could be pointed at, and a
  // boolean cannot express which. Wrapping the id in an object keeps "closed"
  // (null) distinguishable from "creating" (id: null).
  const [editorTarget, setEditorTarget] = useState<{ id: string | null } | null>(null)

  // Contributed settings rows are derived from installed MANIFESTS, so Settings
  // lists them without importing a single extension bundle.
  //
  // There used to be an `extensionCommands` memo here too. It was dead: an earlier
  // revision passed it to getSettingsRegistry for a "Commands" settings category
  // that was replaced upstream by CommandKeybindingsRow, which derives its own. The
  // memo survived as a dependency of the line below and nothing else — computing a
  // command list on every install just to feed it to an array it was not in.
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const registry = useMemo(() => getSettingsRegistry(installedExtensions), [installedExtensions])
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
      // ⌘[ / ⌘] step categories from anywhere on the page (plan D5) — also
      // the only category navigation on a window narrower than `md`, where
      // the sidebar is hidden. Yields inside code editors and textareas.
      onKeyDown={event => {
        const ids: Array<SettingCategoryId | 'all'> = ['all', ...SETTING_CATEGORIES.map(category => category.id)]
        const next = sectionCycleTarget(event, Math.max(0, ids.indexOf(selectedCategory)), ids.length)
        if (next === null) return
        event.preventDefault()
        setSelectedCategory(ids[next]!)
      }}
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
            {/* Escape closes Settings (useKeybinds' focus-mode handler), so the
                button says so (plan H2). Ghost, the close-only idiom (H5). */}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
              <Kbd binding="Escape" />
            </Button>
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
              openThemeEditor: (themeId: string | null) => setEditorTarget({ id: themeId }),
              deleteSavedTheme: (themeId: string) => {
                // WHY no confirmation dialog: the prompt-template delete this
                // UI is modelled on has none either, and a theme is cheap to
                // recreate. If this proves wrong, a confirm is a one-liner.
                //
                // Falling back to the default mode when the ACTIVE theme is
                // deleted is what triggers applyTheme's clear-all path. Without
                // it the 81 inline properties would keep outranking every
                // [data-mode] block and the app would look broken until reload.
                const savedThemes = settings.savedThemes.filter(theme => theme.id !== themeId)
                onChange({
                  savedThemes,
                  mode: settings.mode === themeId ? DEFAULT_SETTINGS.mode : settings.mode,
                })
              },
            }}
          />
        </div>
      </div>

      {editorTarget ? (
        <ThemeEditorModal
          theme={editorTarget.id ? findSavedTheme(settings.savedThemes, editorTarget.id) : null}
          onClose={() => setEditorTarget(null)}
          onSave={(name, json, asCopy) => {
            const existing = editorTarget.id
              ? findSavedTheme(settings.savedThemes, editorTarget.id)
              : null
            // Saving always selects the theme, matching the old custom-appearance
            // behavior where saving implied "and use this now". "Save a copy"
            // takes the create branch on purpose: it mints a new id so the
            // original is left exactly as it was.
            if (existing && !asCopy) {
              const updated: SavedTheme = { ...existing, name, json, updatedAt: Date.now() }
              onChange({
                savedThemes: settings.savedThemes.map(t => (t.id === existing.id ? updated : t)),
                mode: updated.id,
              })
            } else {
              const created = createSavedTheme(name, json)
              onChange({
                savedThemes: [...settings.savedThemes, created],
                mode: created.id,
              })
            }
            setEditorTarget(null)
          }}
        />
      ) : null}
    </div>
  )
}

export function ThemeEditorModal({
  theme,
  onClose,
  onSave,
}: {
  theme: SavedTheme | null
  onClose: () => void
  onSave: (name: string, json: string, asCopy: boolean) => void
}) {
  // WHY a new theme seeds from readAppliedAppearance() rather than from
  // DEFAULT_CUSTOM_APPEARANCE: it makes "+ New theme…" mean "duplicate what I
  // am looking at", so the very first save is the user's current theme plus
  // their one edit. Seeding from the hardcoded dark default would drop a
  // Tokyonight user into an unrecognizable palette the moment they saved. It
  // is also the ONLY way to reach built-in palette values at all — they exist
  // solely as CSS in [data-mode] blocks (see savedThemes.ts).
  const [initialDraft] = useState(
    () => theme?.json ?? stringifyCustomAppearance(readAppliedAppearance()),
  )
  const [draft, setDraft] = useState(initialDraft)
  const [name, setName] = useState(theme?.name ?? '')
  // The JSON draft is REAL typed input (B7's condition on plan D3): Escape,
  // an outside click and Cancel all route through requestClose, which asks
  // before discarding edits and closes at once when there are none.
  const dirty = draft !== initialDraft || name !== (theme?.name ?? '')
  const requestClose = async () => {
    if (dirty && !(await requestConfirm({
      title: 'Discard theme changes?',
      description: 'The edited JSON and name will be lost.',
      confirmLabel: 'Discard Changes',
      tone: 'danger',
    }))) return
    onClose()
  }
  const [view, setView] = useState<'json' | 'schema'>('json')
  const [error, setError] = useState<string | null>(null)

  // Validation stays save-time only, as before: the draft is raw user text and
  // validating per keystroke would flag every half-typed hex as an error.
  const save = (asCopy: boolean) => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required')
      return
    }
    try {
      parseCustomAppearanceJson(draft)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    onSave(trimmed, draft, asCopy)
  }

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) void requestClose()
      }}
    >
      {/* Sized to the window like Settings itself (an editor, not a form):
          a deliberate non-preset width (plan T2). The standard surface and
          header replace the popover/panel-header colours only this dialog
          used (plan T3). */}
      <DialogContent className="flex h-[calc(100vh-3rem)] max-h-[760px] w-[calc(100vw-3rem)] max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="flex items-center justify-between gap-3">
          <div>
            <DialogTitle>
              {theme ? 'Edit Theme' : 'New Theme'}
            </DialogTitle>
            <DialogDescription>
              Name your color scheme and define its application tokens as validated JSON.
            </DialogDescription>
          </div>
          {/* The header "Close" button that sat here is gone: a second exit
              beside the footer's Cancel ⎋ (plan H5). */}
          <Button
            type="button"
            onClick={() => setView(view === 'json' ? 'schema' : 'json')}
            variant="ghost"
            size="sm"
            aria-pressed={view === 'schema'}
          >
            {view === 'json' ? 'Show Schema' : 'Show JSON'}
          </Button>
        </DialogHeader>

        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <label
            htmlFor="theme-name"
            className="text-[10px] uppercase tracking-wider text-muted"
          >
            Name
          </label>
          {/* autoFocus lives here rather than on the textarea: for a new theme
              the name is the empty field, and for an edit it is still the field
              most likely to be changed. */}
          <Input
            id="theme-name"
            autoFocus
            value={name}
            maxLength={SAVED_THEME_NAME_MAX}
            onChange={event => {
              setName(event.target.value)
              setError(null)
            }}
            placeholder="Nord Night"
            className="max-w-xs"
          />
        </div>

        <div className="min-h-0 flex-1 px-4 py-3">
          {view === 'json' ? (
            <Textarea
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                setError(null)
              }}
              spellCheck={false}
              className="h-full min-h-[420px] resize-none rounded-slab bg-code-bg px-3 py-3 text-[12px] leading-5 text-code-ink"
            />
          ) : (
            <pre className="h-full min-h-[420px] overflow-auto rounded-slab border border-input-border bg-code-bg px-3 py-3 text-[12px] leading-5 text-code-ink">
              {CUSTOM_APPEARANCE_SCHEMA_JSON}
            </pre>
          )}
        </div>

        {/* ⌘↩ saves & applies (the JSON textarea owns plain Enter). Save a
            Copy is only offered when editing — "save a copy" of a theme that
            does not exist yet is just "save". The save error rides in the
            left slot. */}
        <DialogActions
          confirmLabel="Save & Apply"
          confirmKey="Cmd+Enter"
          onConfirm={() => save(false)}
          onCancel={() => void requestClose()}
          extraActions={theme ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => save(true)}>
              Save a Copy
            </Button>
          ) : null}
        >
          {error ? <span className="text-danger">{error}</span> : null}
        </DialogActions>
      </DialogContent>
    </Dialog>
  )
}
