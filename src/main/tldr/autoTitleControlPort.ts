import type { createControlHost } from '@main/control/createControlHost.js'

type ControlHost = Pick<ReturnType<typeof createControlHost>, 'catalog' | 'forCaller'>

/** The session window lease, rather than a fleet-wide observation, chooses
 * the renderer. An unrelated window can be loading or hung while this agent's
 * pane remains healthy; asking every window before a self-scoped title write
 * would make that unrelated window a dependency of both the tool and hook. */
export function createAutoTitleControlPort(
  controlHost: ControlHost,
  windowForSession: (sessionId: string) => string | null,
) {
  const caller = controlHost.forCaller({ kind: 'application', id: 'auto-title' })
  const ownerFor = (sessionId: string) => {
    const windowId = windowForSession(sessionId)
    const owner = windowId ? controlHost.catalog().find(row =>
      row.descriptor.id === 'agents.autoTitleSet'
      && row.owner.kind === 'window' && row.owner.windowId === windowId)?.owner : undefined
    if (!owner) throw new Error('Auto Title agent window is unavailable.')
    return owner
  }

  return {
    set: async (sessionId: string, title: string, authorized: () => boolean): Promise<string> => {
      // The MCP bearer selected the session before this port was called. Its
      // liveness is checked around the async IPC, while the renderer checks
      // current SessionMeta and manual-title precedence at the actual write.
      if (!authorized()) throw new Error('Auto Title session is no longer active.')
      const result = await caller.invoke({
        capabilityId: 'agents.autoTitleSet', input: { sessionId, title }, owner: ownerFor(sessionId),
      })
      if (!authorized()) throw new Error('Auto Title session is no longer active.')
      if (!result.ok) throw new Error(result.error.message)
      const value = result.value as { title?: unknown }
      if (typeof value.title !== 'string') throw new Error('Auto Title write returned no title.')
      return value.title
    },
    state: async (sessionId: string): Promise<{ missing: boolean }> => {
      const result = await caller.invoke({
        capabilityId: 'agents.autoTitleState', input: { sessionId }, owner: ownerFor(sessionId),
      })
      if (!result.ok) throw new Error(result.error.message)
      const value = result.value as { missing?: unknown }
      if (typeof value.missing !== 'boolean') throw new Error('Auto Title state is unavailable.')
      return { missing: value.missing }
    },
  }
}
