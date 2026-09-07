import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'

// WHY this exists (issue #494): App.tsx was the only owner of the
// useWorkspace() hook value and therefore had to mount every feature
// surface itself, prop-drilling `workspace` into ~15 components. This
// context lets surface wrappers (app/surfaces/registry.tsx) be
// self-contained files that App never has to know about.
//
// Layout/controller changes still publish a new context because actions may
// close over that state. Runtime traffic no longer renders the controller:
// panes subscribe by session, while useWorkspaceContext below explicitly keeps
// broad inspection surfaces reactive. Do not freeze action closures or assume
// an imperative getRuntime read constitutes a React subscription.
//
// NOTE for the remote client: this file must stay Electron-free (it is —
// pure React). The phone bundle never mounts WorkspaceProvider, so
// anything consuming useWorkspaceContext() is desktop-only by
// construction.
const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: Workspace
  children: ReactNode
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceLayoutContext(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) {
    // Loud failure beats a silent null: a surface rendered outside the
    // provider is a composition-root wiring bug, never a legitimate state.
    throw new Error('useWorkspaceContext must be used inside <WorkspaceProvider>')
  }
  return workspace
}

// Broad inspection surfaces (debug, palette, multi-agent modals) explicitly
// retain their reactive runtime view. Layout shells instead use the layout
// hook above; individual panes subscribe by session id. Do not freeze action
// closures: the provider still updates whenever controller/layout state changes.
export function useWorkspaceContext(): Workspace {
  const workspace = useWorkspaceLayoutContext()
  const runtimes = useAppStore(state => state.workspaceRuntimes)
  return { ...workspace, runtimes }
}
