import { z } from 'zod'
import { ControlError, defineCapability } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'

// These routes are the shell's existing open/close operations. No settings,
// editor buffers or provider state are synthesized by the control surface.
// Keeping the table beside this owner makes adding a named surface an explicit
// choice about state and close semantics, rather than arbitrary store writes.
const routes = {
  settings: { field: 'settingsPageOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openSettingsPage() : s.closeSettingsPage() } },
  shortcuts: { field: 'keyboardShortcutsOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openKeyboardShortcuts() : s.closeKeyboardShortcuts() } },
  usage: { field: 'usageModalOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openUsageModal() : s.closeUsageModal() } },
  worktrees: { field: 'worktreesBarOpen', toggle: () => useAppStore.getState().toggleWorktreesBar() },
  git: { field: 'gitBarOpen', toggle: () => useAppStore.getState().toggleGitBar() },
  agentStatus: { field: 'agentStatusPanelOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openAgentStatusPanel() : s.closeAgentStatusPanel() } },
  activity: { field: 'agentActivityOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openAgentActivity() : s.closeAgentActivity() } },
  promptSearch: { field: 'promptSearchOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openPromptSearch() : s.closePromptSearch() } },
  editor: { field: 'globalEditorOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openGlobalEditor() : s.closeGlobalEditor() } },
  performance: { field: 'performancePanelOpen', toggle: () => useAppStore.getState().togglePerformancePanel() },
  remote: { field: 'remotePanelOpen', toggle: () => useAppStore.getState().toggleRemotePanel() },
} as const
const surfaceId = z.enum(Object.keys(routes) as [keyof typeof routes, ...(keyof typeof routes)[]])
const surface = z.object({ surfaceId, open: z.boolean() })
export function surfaceControlCapabilities() {
  const state = (id: keyof typeof routes) => Boolean(useAppStore.getState()[routes[id].field])
  return [
    defineCapability({ id: 'ui.surfaces', title: 'Inspect named application panels', execution: 'window', effect: 'read',
      description: 'List supported shell panels and their open state in this window. Does not report a panel as keyboard owner; app.observe reports blocking input ownership. Other app features remain discoverable through features.list and commands.list.',
      input: z.object({}).strict(), output: z.object({ surfaces: z.array(surface) }), handler: () => ({ surfaces: Object.keys(routes).map(id => ({ surfaceId: id as keyof typeof routes, open: state(id as keyof typeof routes) })) }),
    }),
    defineCapability({ id: 'ui.surfaceSet', title: 'Open or close a named panel', execution: 'window', effect: 'ui',
      description: 'Set a supported shell panel open or closed through its existing operation, without accidental toggles. Refuses opening behind another input-owning surface. Closing a panel preserves drafts and editor buffers; it does not save them. Panels such as Worktrees use the selected project context: navigate to the intended agent first, then inspect the actual UI before interaction.',
      input: surface.strict(), output: surface,
      handler: async input => {
        if (state(input.surfaceId) === input.open) return input
        if (input.open && hasAppInteractionOwner()) throw new ControlError('unavailable', 'Another surface owns input; finish or close it first')
        routes[input.surfaceId].toggle(input.open)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        if (state(input.surfaceId) !== input.open) throw new ControlError('failed', 'Surface state changed before acknowledgment', 'unknown')
        return input
      },
    }),
  ]
}
