import { create } from 'zustand'
import { createJSONStorage, devtools, persist, subscribeWithSelector } from 'zustand/middleware'

import { createSettingsSlice } from '@renderer/app-state/settings/slice'
import { createUiShellSlice } from '@renderer/app-state/uiShell/slice'
import { createWorkspaceSlice } from '@renderer/app-state/workspace/slice'
import type { AppStore } from '@renderer/app-state/types'
import type { Settings } from '@renderer/app-state/settings/types'
import { coerceSettings } from '@renderer/app-state/settings/persistence'
import {
  APP_STORE_STORAGE_KEY,
  PROMPT_TEMPLATES_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'

function readLegacyPromptTemplatesFromStandaloneStorage(): unknown {
  try {
    const raw = localStorage.getItem(PROMPT_TEMPLATES_STORAGE_KEY)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

export const useAppStore = create<AppStore>()(
  devtools(
    persist(
      subscribeWithSelector((...args) => ({
        ...createSettingsSlice(...args),
        ...createUiShellSlice(...args),
        ...createWorkspaceSlice(...args),
      })),
      {
        name: APP_STORE_STORAGE_KEY,
        // HISTORICALLY: bump whenever a new persisted `Settings` field is
        // added, because coerceSettings only ran inside `migrate`.
        //
        // THAT IS NO LONGER TRUE — and the rest of this comment is the record
        // of why the rule existed, not a live instruction. `merge` below now
        // calls coerceSettings unconditionally on EVERY hydration (see the WHY
        // there), so a newly added field is backfilled for same-version blobs
        // without any bump. `settings.dictationMouseButton` was added this way
        // and deliberately did not bump v10. Bump only when a change needs
        // more than default-backfilling — a value REINTERPRETED or migrated
        // from an older shape, which is what every entry below actually was.
        //
        // #249 added `commandVisibilityOverrides`
        // without bumping the version, so every existing user (already at v2)
        // skipped coercion, loaded settings without that field, and the command
        // registry's `commandVisible` dereferenced `undefined[id]` → black
        // screen on launch. v3 forces a re-coerce so the field is backfilled.
        //
        // v4 adds `settings.agentViewMode`. Without a bump, existing v3 users
        // would skip coercion and thread `undefined` into the render-policy
        // selector, making the app's most central pane decision depend on a
        // missing persisted key.
        //
        // v5 adds `settings.savedThemes` and widens `settings.mode` to hold a
        // `theme:<uuid>` id. Without a bump, an existing v4 user sitting on
        // `mode: 'custom'` would skip migration, keep a mode value that no
        // longer resolves to anything, and boot to Dark with their custom
        // palette silently orphaned inside customAppearanceJson.
        //
        // v6 adds `settings.savedPromptTemplates`. v7 adds
        // `settings.dispatchColorFlags`. Existing users must re-run coercion so
        // the new keys are always present in hydrated state.
        //
        // v8 adds `settings.defaultBuiltInMcpDomains`. The empty array is a
        // real product default and downstream session initialization reads it
        // synchronously, so older blobs must be backfilled before workspace
        // bootstrap can create or recover an agent.
        version: 10,
        storage: createJSONStorage(() => localStorage),
        partialize: state => ({ settings: state.settings }),
        merge: (persisted, current) => {
          const data = persisted as { settings?: Partial<Settings> } | undefined
          const legacyPromptTemplates = data?.settings?.savedPromptTemplates === undefined
            ? readLegacyPromptTemplatesFromStandaloneStorage()
            : undefined
          return {
            ...current,
            // WHY coerce on merge as well as migrate:
            // Zustand only calls `migrate` when the stored version is older
            // than the current version. Same-version blobs can still be
            // incomplete: interrupted writes, localStorage edits, dev builds,
            // or a field added during a branch before the version bump lands.
            // A missing settings.agentViewMode is especially dangerous
            // because the pane renderer treats anything other than explicit
            // "agent" / "terminal" as Hybrid-like terminal-first behavior.
            // Running the same coercion at the final merge point makes every
            // launch shape-safe, not just older-version launches.
            settings: coerceSettings({
              ...data?.settings,
              savedPromptTemplates: data?.settings?.savedPromptTemplates ?? legacyPromptTemplates,
            }),
          }
        },
        migrate: (persisted, version) => {
          const data = persisted as { settings?: Partial<Settings> } | undefined
          const legacyPromptTemplates = version < 6 && data?.settings?.savedPromptTemplates === undefined
            ? readLegacyPromptTemplatesFromStandaloneStorage()
            : undefined
          return {
            settings: coerceSettings({
              ...data?.settings,
              savedPromptTemplates: data?.settings?.savedPromptTemplates ?? legacyPromptTemplates,
            }),
          } as Partial<AppStore>
        },
      },
    ),
    { name: APP_DISPLAY_NAME },
  ),
)
