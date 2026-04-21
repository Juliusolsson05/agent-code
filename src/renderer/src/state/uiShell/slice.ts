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
  buryPromptSessionId: null,
  viewPromptsSessionId: null,
  newAgentPlacementOpen: false,
  gitBarOpen: false,
  debugPanelOpen: false,
  feedDebugPanelOpen: false,
  proxyDebugPanelOpen: false,
  htmlDebugPanelOpen: false,
  promptSearchOpen: false,
  agentActivityOpen: false,

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

  openBuryPrompt: sessionId =>
    set({ buryPromptSessionId: sessionId }, false, 'uiShell/openBuryPrompt'),
  closeBuryPrompt: () =>
    set({ buryPromptSessionId: null }, false, 'uiShell/closeBuryPrompt'),

  openViewPrompts: sessionId =>
    set({ viewPromptsSessionId: sessionId }, false, 'uiShell/openViewPrompts'),
  closeViewPrompts: () =>
    set({ viewPromptsSessionId: null }, false, 'uiShell/closeViewPrompts'),

  openNewAgentPlacement: () =>
    set({ newAgentPlacementOpen: true }, false, 'uiShell/openNewAgentPlacement'),
  closeNewAgentPlacement: () =>
    set({ newAgentPlacementOpen: false }, false, 'uiShell/closeNewAgentPlacement'),

  toggleGitBar: () =>
    set(state => ({ gitBarOpen: !state.gitBarOpen }), false, 'uiShell/toggleGitBar'),
  toggleDebugPanel: () =>
    set(state => ({ debugPanelOpen: !state.debugPanelOpen }), false, 'uiShell/toggleDebugPanel'),
  toggleFeedDebugPanel: () =>
    set(
      state => ({ feedDebugPanelOpen: !state.feedDebugPanelOpen }),
      false,
      'uiShell/toggleFeedDebugPanel',
    ),
  toggleProxyDebugPanel: () =>
    set(
      state => ({ proxyDebugPanelOpen: !state.proxyDebugPanelOpen }),
      false,
      'uiShell/toggleProxyDebugPanel',
    ),
  toggleHtmlDebugPanel: () =>
    set(
      state => ({ htmlDebugPanelOpen: !state.htmlDebugPanelOpen }),
      false,
      'uiShell/toggleHtmlDebugPanel',
    ),

  openPromptSearch: () =>
    set({ promptSearchOpen: true }, false, 'uiShell/openPromptSearch'),
  closePromptSearch: () =>
    set({ promptSearchOpen: false }, false, 'uiShell/closePromptSearch'),

  openAgentActivity: () =>
    set({ agentActivityOpen: true }, false, 'uiShell/openAgentActivity'),
  closeAgentActivity: () =>
    set({ agentActivityOpen: false }, false, 'uiShell/closeAgentActivity'),
})
