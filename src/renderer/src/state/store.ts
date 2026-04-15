import { create } from 'zustand'
import { createJSONStorage, devtools, persist, subscribeWithSelector } from 'zustand/middleware'

import { createSettingsSlice } from './settings/slice'
import { createUiShellSlice } from './uiShell/slice'
import { createWorkspaceSlice } from './workspace/slice'
import type { AppStore } from './types'
import { DEFAULT_SETTINGS, THEME_MODES, type Settings } from './settings/types'

export const useAppStore = create<AppStore>()(
  devtools(
    persist(
      subscribeWithSelector((...args) => ({
        ...createSettingsSlice(...args),
        ...createUiShellSlice(...args),
        ...createWorkspaceSlice(...args),
      })),
      {
        name: 'cc-shell:app-store',
        version: 2,
        storage: createJSONStorage(() => localStorage),
        partialize: state => ({ settings: state.settings }),
        migrate: persisted => {
          const data = persisted as { settings?: Partial<Settings> } | undefined
          return {
            settings: {
              ...DEFAULT_SETTINGS,
              ...data?.settings,
              mode: THEME_MODES.some(option => option.id === data?.settings?.mode)
                ? (data?.settings?.mode as Settings['mode'])
                : DEFAULT_SETTINGS.mode,
              contrast: data?.settings?.contrast === true,
              accent: data?.settings?.accent ?? DEFAULT_SETTINGS.accent,
              customRendering: data?.settings?.customRendering === true,
              dangerousAgentsEnabled: data?.settings?.dangerousAgentsEnabled === true,
              useProxyStreaming: data?.settings?.useProxyStreaming === true,
            },
          } as Partial<AppStore>
        },
      },
    ),
    { name: 'cc-shell' },
  ),
)
