import type { StateCreator } from 'zustand'

import type { AppStore, UiShellSlice } from '@renderer/app-state/types'

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
  reorderTabsOpen: false,
  pinAgentsOpen: false,
  settingsPageOpen: false,
  buryPromptSessionId: null,
  viewPromptsSessionId: null,
  newAgentPlacementOpen: false,
  dispatchAttachIntent: null,
  linkedAgentParentId: null,
  gitBarOpen: false,
  worktreesBarOpen: false,
  debugPanelOpen: false,
  feedDebugPanelOpen: false,
  proxyDebugPanelOpen: false,
  htmlDebugPanelOpen: false,
  devDebugPanelOpen: false,
  performancePanelOpen: false,
  globalEditorOpen: false,
  promptSearchOpen: false,
  agentActivityOpen: false,
  rewindPromptSessionId: null,
  // Default keeps the dispatch list at 25% (matching the
  // previous-hardcoded `basis-1/4`) so the migration is visually a
  // no-op. The clamp range in setDispatchListRatio is what enforces
  // sane bounds when the user actually drags the splitter.
  dispatchListRatio: 0.25,

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

  openReorderTabs: () =>
    set({ reorderTabsOpen: true }, false, 'uiShell/openReorderTabs'),
  closeReorderTabs: () =>
    set({ reorderTabsOpen: false }, false, 'uiShell/closeReorderTabs'),

  openPinAgents: () =>
    set({ pinAgentsOpen: true }, false, 'uiShell/openPinAgents'),
  closePinAgents: () =>
    set({ pinAgentsOpen: false }, false, 'uiShell/closePinAgents'),

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

  openDispatchAttach: sessionId =>
    set({ dispatchAttachIntent: sessionId }, false, 'uiShell/openDispatchAttach'),
  closeDispatchAttach: () =>
    set({ dispatchAttachIntent: null }, false, 'uiShell/closeDispatchAttach'),

  openLinkedAgent: sessionId =>
    set({ linkedAgentParentId: sessionId }, false, 'uiShell/openLinkedAgent'),
  closeLinkedAgent: () =>
    set({ linkedAgentParentId: null }, false, 'uiShell/closeLinkedAgent'),

  toggleGitBar: () =>
    set(state => ({ gitBarOpen: !state.gitBarOpen }), false, 'uiShell/toggleGitBar'),
  toggleWorktreesBar: () =>
    set(
      state => ({ worktreesBarOpen: !state.worktreesBarOpen }),
      false,
      'uiShell/toggleWorktreesBar',
    ),
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
  toggleDevDebugPanel: () =>
    set(
      state => ({ devDebugPanelOpen: !state.devDebugPanelOpen }),
      false,
      'uiShell/toggleDevDebugPanel',
    ),
  togglePerformancePanel: () =>
    set(
      state => ({ performancePanelOpen: !state.performancePanelOpen }),
      false,
      'uiShell/togglePerformancePanel',
    ),

  openGlobalEditor: () =>
    set({ globalEditorOpen: true }, false, 'uiShell/openGlobalEditor'),
  closeGlobalEditor: () =>
    set({ globalEditorOpen: false }, false, 'uiShell/closeGlobalEditor'),
  toggleGlobalEditor: () =>
    set(
      state => ({ globalEditorOpen: !state.globalEditorOpen }),
      false,
      'uiShell/toggleGlobalEditor',
    ),

  // WHY clamp range [0.15, 0.5]:
  //   Below 0.15 the dispatch row titles are unreadably truncated
  //   (the existing min-w on each row is 220px, so percentages below
  //   that just push the agent pane horizontally without giving the
  //   list more usable space). Above 0.5 the agent pane — the thing
  //   the user is actually working in — gets squeezed below half the
  //   screen, which defeats the purpose of dispatch mode. The cap
  //   isn't a moral judgment, it's a "this stops being useful"
  //   threshold; loosen it later if real usage shows the bounds are
  //   wrong.
  setDispatchListRatio: ratio =>
    set(
      { dispatchListRatio: Math.min(0.5, Math.max(0.15, ratio)) },
      false,
      'uiShell/setDispatchListRatio',
    ),

  openPromptSearch: () =>
    set({ promptSearchOpen: true }, false, 'uiShell/openPromptSearch'),
  closePromptSearch: () =>
    set({ promptSearchOpen: false }, false, 'uiShell/closePromptSearch'),

  openAgentActivity: () =>
    set({ agentActivityOpen: true }, false, 'uiShell/openAgentActivity'),
  closeAgentActivity: () =>
    set({ agentActivityOpen: false }, false, 'uiShell/closeAgentActivity'),

  openRewindPrompt: sessionId =>
    set({ rewindPromptSessionId: sessionId }, false, 'uiShell/openRewindPrompt'),
  closeRewindPrompt: () =>
    set({ rewindPromptSessionId: null }, false, 'uiShell/closeRewindPrompt'),
})
