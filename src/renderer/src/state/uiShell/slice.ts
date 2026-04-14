import type { StateCreator } from 'zustand'

import type { AppStore, UiShellSlice } from '../types'

export const createUiShellSlice: StateCreator<
  AppStore,
  [['zustand/devtools', never], ['zustand/subscribeWithSelector', never]],
  [],
  UiShellSlice
> = set => ({
  commandPaletteOpen: false,
  pathPickerOpen: false,
  pathPickerDefault: '',
  tileTabsModalOpen: false,
  tileTabsInitialSelectedIds: [],
  settingsPageOpen: false,
  gitBarOpen: false,
  debugPanelOpen: false,

  openCommandPalette: () =>
    set({ commandPaletteOpen: true }, false, 'uiShell/openCommandPalette'),
  closeCommandPalette: () =>
    set({ commandPaletteOpen: false }, false, 'uiShell/closeCommandPalette'),
  toggleCommandPalette: () =>
    set(state => ({ commandPaletteOpen: !state.commandPaletteOpen }), false, 'uiShell/toggleCommandPalette'),

  openPathPicker: (defaultValue = '') =>
    set({
      pathPickerOpen: true,
      pathPickerDefault: defaultValue,
    }, false, 'uiShell/openPathPicker'),
  closePathPicker: () =>
    set({ pathPickerOpen: false }, false, 'uiShell/closePathPicker'),
  setPathPickerDefault: value =>
    set({ pathPickerDefault: value }, false, 'uiShell/setPathPickerDefault'),

  openTileTabsModal: initialSelectedIds =>
    set({
      tileTabsModalOpen: true,
      tileTabsInitialSelectedIds: initialSelectedIds,
    }, false, 'uiShell/openTileTabsModal'),
  closeTileTabsModal: () =>
    set({ tileTabsModalOpen: false }, false, 'uiShell/closeTileTabsModal'),

  openSettingsPage: () =>
    set({ settingsPageOpen: true }, false, 'uiShell/openSettingsPage'),
  closeSettingsPage: () =>
    set({ settingsPageOpen: false }, false, 'uiShell/closeSettingsPage'),

  toggleGitBar: () =>
    set(state => ({ gitBarOpen: !state.gitBarOpen }), false, 'uiShell/toggleGitBar'),
  toggleDebugPanel: () =>
    set(state => ({ debugPanelOpen: !state.debugPanelOpen }), false, 'uiShell/toggleDebugPanel'),
})
