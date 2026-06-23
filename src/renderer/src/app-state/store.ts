import { create } from 'zustand'
import { createJSONStorage, devtools, persist, subscribeWithSelector } from 'zustand/middleware'

import { createSettingsSlice } from '@renderer/app-state/settings/slice'
import { createUiShellSlice } from '@renderer/app-state/uiShell/slice'
import { createWorkspaceSlice } from '@renderer/app-state/workspace/slice'
import type { AppStore } from '@renderer/app-state/types'
import type { Settings } from '@renderer/app-state/settings/types'
import { coerceSettings } from '@renderer/app-state/settings/persistence'
import { APP_STORE_STORAGE_KEY } from '@renderer/app-state/localStorageMigration'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'

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
        // BUMP THIS whenever a new persisted `Settings` field is added.
        // coerceSettings (which fills defaults for missing fields) only runs
        // inside `migrate`, and `migrate` only fires when the persisted version
        // is older than this number. #249 added `commandVisibilityOverrides`
        // without bumping the version, so every existing user (already at v2)
        // skipped coercion, loaded settings without that field, and the command
        // registry's `commandVisible` dereferenced `undefined[id]` → black
        // screen on launch. v3 forces a re-coerce so the field is backfilled.
        //
        // v4 adds `settings.agentViewMode`. Without a bump, existing v3 users
        // would skip coercion and thread `undefined` into the render-policy
        // selector, making the app's most central pane decision depend on a
        // missing persisted key.
        version: 4,
        storage: createJSONStorage(() => localStorage),
        partialize: state => ({ settings: state.settings }),
        migrate: persisted => {
          const data = persisted as { settings?: Partial<Settings> } | undefined
          return {
            settings: coerceSettings(data?.settings),
          } as Partial<AppStore>
        },
      },
    ),
    { name: APP_DISPLAY_NAME },
  ),
)
