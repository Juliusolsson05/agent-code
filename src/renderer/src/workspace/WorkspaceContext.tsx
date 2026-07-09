import { createContext, useContext, type ReactNode } from 'react'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// WHY this exists (issue #494): App.tsx was the only owner of the
// useWorkspace() hook value and therefore had to mount every feature
// surface itself, prop-drilling `workspace` into ~15 components. This
// context lets surface wrappers (app/surfaces/registry.tsx) be
// self-contained files that App never has to know about.
//
// Re-render semantics — deliberately unchanged from prop drilling: the
// context value is the object useWorkspace() returns, which has a fresh
// identity on every App render, so every consumer re-renders whenever
// App does. That is exactly what the prop-drilled components already
// did. Do NOT try to memoize the workspace object here to "optimize" —
// its methods close over current state and a stale snapshot is a
// correctness bug, not a perf win.
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

export function useWorkspaceContext(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) {
    // Loud failure beats a silent null: a surface rendered outside the
    // provider is a composition-root wiring bug, never a legitimate state.
    throw new Error('useWorkspaceContext must be used inside <WorkspaceProvider>')
  }
  return workspace
}
