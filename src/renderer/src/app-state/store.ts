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
        version: 2,
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
