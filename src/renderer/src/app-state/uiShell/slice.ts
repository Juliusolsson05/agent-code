import { DEFAULT_PALETTE_MODE } from '@renderer/features/command-palette/paletteMode'
import type { PaletteMode } from '@renderer/features/command-palette/paletteMode'
import type { StateCreator } from 'zustand'

import type { AppStore, UiShellSlice } from '@renderer/app-state/types'
import type { PendingCommandInvocation } from '@renderer/app-state/uiShell/types'

export const createUiShellSlice: StateCreator<
  AppStore,
  [['zustand/devtools', never], ['zustand/subscribeWithSelector', never]],
  [],
  UiShellSlice
> = set => ({
  commandPaletteOpen: false,
  paletteMode: DEFAULT_PALETTE_MODE,
  pathPickerOpen: false,
  pathPickerDefault: '',
  tileTabsModalOpen: false,
  tileTabsInitialSelectedIds: [],
  reorderTabsOpen: false,
  pinAgentsOpen: false,
  settingsPageOpen: false,
  agentTitlePromptSessionId: null,
  buryPromptSessionId: null,
  debugBundleNotePrompt: null,
  recordingNotePrompt: null,
  viewPromptsSessionId: null,
  newAgentPlacementOpen: false,
  newAgentProjectIntent: null,
  tiledDispatchPromptOpen: false,
  dispatchAttachIntent: null,
  linkedAgentParentId: null,
  gitBarOpen: false,
  worktreesBarOpen: false,
  debugPanelOpen: false,
  feedDebugPanelOpen: false,
  proxyDebugPanelOpen: false,
  htmlDebugPanelOpen: false,
  renderingDebugMode: false,
  tailAllMode: false,
  devDebugPanelOpen: false,
  agentStatusPanelOpen: false,
  performancePanelOpen: false,
  remotePanelOpen: false,
  globalEditorOpen: false,
  promptSearchOpen: false,
  agentActivityOpen: false,
  keyboardShortcutsOpen: false,
  closeOldAgentsOpen: false,
  bulkProviderSwitchOpen: false,
  usageModalOpen: false,
  rewindPromptSessionId: null,
  agentViewModePickerSessionId: null,
  colorFlagPickerSessionId: null,
  // Default keeps the dispatch list at 25% (matching the
  // previous-hardcoded `basis-1/4`) so the migration is visually a
  // no-op. The clamp range in setDispatchListRatio is what enforces
  // sane bounds when the user actually drags the splitter.
  dispatchListRatio: 0.25,
  pendingCommandInvocation: null,

  // Records the request and opens the palette when it is closed, because the
  // palette component is what owns the live CommandContext. `closeAfterRun`
  // remembers that it was opened only to service this invocation, so a chord
  // does not leave the palette on screen.
  // Deliberately does NOT open the palette. The command host mounts itself when
  // an invocation is pending (see CommandPalette), so the context gets built
  // without the palette becoming visible — a chord must not flash a modal.
  requestCommandInvocation: (id: string, source: PendingCommandInvocation['source']) =>
    set(state => ({
      pendingCommandInvocation: { id, source, closeAfterRun: !state.commandPaletteOpen },
    }), false, 'uiShell/requestCommandInvocation'),
  clearCommandInvocation: () =>
    set({ pendingCommandInvocation: null }, false, 'uiShell/clearCommandInvocation'),

  // Opening always lands in the command list. Reopening should never resume a
  // half-finished sub-flow the user abandoned.
  openCommandPalette: () =>
    set({ commandPaletteOpen: true, paletteMode: DEFAULT_PALETTE_MODE }, false, 'uiShell/openCommandPalette'),
  closeCommandPalette: () =>
    set({ commandPaletteOpen: false, paletteMode: DEFAULT_PALETTE_MODE }, false, 'uiShell/closeCommandPalette'),
  /**
   * Enter a sub-mode, MAKING THE PALETTE VISIBLE.
   *
   * The open is not a convenience — it is the correctness fix. A sub-mode is
   * only meaningful rendered, so every caller wanted the palette up; the ones
   * invoked from a chord simply had no way to say so, because `setMode` was
   * component-local and the host they were mutating was invisible.
   *
   * Coupling the two here means a future mode-entry point cannot forget it.
   */
  setPaletteMode: (mode: PaletteMode) =>
    set({ paletteMode: mode, commandPaletteOpen: true }, false, 'uiShell/setPaletteMode'),

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

  openAgentTitlePrompt: sessionId =>
    set({ agentTitlePromptSessionId: sessionId }, false, 'uiShell/openAgentTitlePrompt'),
  closeAgentTitlePrompt: () =>
    set({ agentTitlePromptSessionId: null }, false, 'uiShell/closeAgentTitlePrompt'),

  openBuryPrompt: sessionId =>
    set({ buryPromptSessionId: sessionId }, false, 'uiShell/openBuryPrompt'),
  closeBuryPrompt: () =>
    set({ buryPromptSessionId: null }, false, 'uiShell/closeBuryPrompt'),

  openDebugBundleNotePrompt: payload =>
    set({ debugBundleNotePrompt: payload }, false, 'uiShell/openDebugBundleNotePrompt'),
  closeDebugBundleNotePrompt: () =>
    set({ debugBundleNotePrompt: null }, false, 'uiShell/closeDebugBundleNotePrompt'),

  // Recording-note prompt (plan §7b). Opened AFTER the reserve IPC has already
  // written the `reserved` marker and returned the noteId — the payload just
  // carries what the fill step needs (sessionId + noteId) plus a title for the
  // modal chrome. Closing WITHOUT submitting is fine and intentional: the
  // reserved marker stays in the recording as a bare "something happened here"
  // flag even if the operator never types a description.
  openRecordingNotePrompt: payload =>
    set({ recordingNotePrompt: payload }, false, 'uiShell/openRecordingNotePrompt'),
  closeRecordingNotePrompt: () =>
    set({ recordingNotePrompt: null }, false, 'uiShell/closeRecordingNotePrompt'),

  openViewPrompts: sessionId =>
    set({ viewPromptsSessionId: sessionId }, false, 'uiShell/openViewPrompts'),
  closeViewPrompts: () =>
    set({ viewPromptsSessionId: null }, false, 'uiShell/closeViewPrompts'),

  openNewAgentPlacement: () =>
    set({ newAgentPlacementOpen: true }, false, 'uiShell/openNewAgentPlacement'),
  openNewAgentForProject: (tabId, anchorSessionId) =>
    set(
      { newAgentPlacementOpen: true, newAgentProjectIntent: { tabId, anchorSessionId } },
      false,
      'uiShell/openNewAgentForProject',
    ),
  closeNewAgentPlacement: () =>
    // Clear the project intent alongside the flag. Leaving it set would make
    // the NEXT ordinary "New Agent…" silently spawn into whichever project
    // the user last clicked "+" on — the classic stale-intent bug.
    set(
      { newAgentPlacementOpen: false, newAgentProjectIntent: null },
      false,
      'uiShell/closeNewAgentPlacement',
    ),
  openTiledDispatchPrompt: () =>
    set({ tiledDispatchPromptOpen: true }, false, 'uiShell/openTiledDispatchPrompt'),
  closeTiledDispatchPrompt: () =>
    set({ tiledDispatchPromptOpen: false }, false, 'uiShell/closeTiledDispatchPrompt'),

  openDispatchAttach: intent =>
    set({ dispatchAttachIntent: intent }, false, 'uiShell/openDispatchAttach'),
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
  toggleRenderingDebugMode: () =>
    set(
      state => ({ renderingDebugMode: !state.renderingDebugMode }),
      false,
      'uiShell/toggleRenderingDebugMode',
    ),
  toggleTailAllMode: () =>
    set(
      state => ({ tailAllMode: !state.tailAllMode }),
      false,
      'uiShell/toggleTailAllMode',
    ),
  toggleDevDebugPanel: () =>
    set(
      state => ({ devDebugPanelOpen: !state.devDebugPanelOpen }),
      false,
      'uiShell/toggleDevDebugPanel',
    ),
  openAgentStatusPanel: () =>
    set({ agentStatusPanelOpen: true }, false, 'uiShell/openAgentStatusPanel'),
  closeAgentStatusPanel: () =>
    set({ agentStatusPanelOpen: false }, false, 'uiShell/closeAgentStatusPanel'),
  toggleAgentStatusPanel: () =>
    set(
      state => ({ agentStatusPanelOpen: !state.agentStatusPanelOpen }),
      false,
      'uiShell/toggleAgentStatusPanel',
    ),
  togglePerformancePanel: () =>
    set(
      state => ({ performancePanelOpen: !state.performancePanelOpen }),
      false,
      'uiShell/togglePerformancePanel',
    ),
  toggleRemotePanel: () =>
    set(
      state => ({ remotePanelOpen: !state.remotePanelOpen }),
      false,
      'uiShell/toggleRemotePanel',
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
  openKeyboardShortcuts: () =>
    set({ keyboardShortcutsOpen: true }, false, 'uiShell/openKeyboardShortcuts'),
  closeKeyboardShortcuts: () =>
    set({ keyboardShortcutsOpen: false }, false, 'uiShell/closeKeyboardShortcuts'),
  openCloseOldAgents: () =>
    set({ closeOldAgentsOpen: true }, false, 'uiShell/openCloseOldAgents'),
  closeCloseOldAgents: () =>
    set({ closeOldAgentsOpen: false }, false, 'uiShell/closeCloseOldAgents'),
  openBulkProviderSwitch: () =>
    set({ bulkProviderSwitchOpen: true }, false, 'uiShell/openBulkProviderSwitch'),
  closeBulkProviderSwitch: () =>
    set({ bulkProviderSwitchOpen: false }, false, 'uiShell/closeBulkProviderSwitch'),
  openUsageModal: () =>
    set({ usageModalOpen: true }, false, 'uiShell/openUsageModal'),
  closeUsageModal: () =>
    set({ usageModalOpen: false }, false, 'uiShell/closeUsageModal'),

  openRewindPrompt: sessionId =>
    set({ rewindPromptSessionId: sessionId }, false, 'uiShell/openRewindPrompt'),
  closeRewindPrompt: () =>
    set({ rewindPromptSessionId: null }, false, 'uiShell/closeRewindPrompt'),

  openAgentViewModePicker: sessionId =>
    set(
      { agentViewModePickerSessionId: sessionId },
      false,
      'uiShell/openAgentViewModePicker',
    ),
  closeAgentViewModePicker: () =>
    set(
      { agentViewModePickerSessionId: null },
      false,
      'uiShell/closeAgentViewModePicker',
    ),

  openColorFlagPicker: sessionId =>
    set({ colorFlagPickerSessionId: sessionId }, false, 'uiShell/openColorFlagPicker'),
  closeColorFlagPicker: () =>
    set({ colorFlagPickerSessionId: null }, false, 'uiShell/closeColorFlagPicker'),
})
