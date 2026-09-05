import { z } from 'zod'
import { controlOwnerSchema, defineCapability, pageInput, pageSchema, paginate, workspaceObservationSchema,
  type ControlContext, type ControlOwner } from '@control-sdk'

export type WindowObservation = { windowId: string; owner: ControlOwner | null;
  workspace?: z.infer<typeof workspaceObservationSchema>; error?: string }
export type ObserveWindows = (context: Omit<ControlContext, 'owner'>) => Promise<WindowObservation[]>

export function globalControlCapabilities(observe: ObserveWindows) {
  const match = workspaceObservationSchema.shape.sessions.element.extend({ owner: controlOwnerSchema })
  return [
    defineCapability({
      id: 'app.observe', title: 'Observe all windows', execution: 'main', effect: 'read',
      description: 'Read every open window, workspace, focus and placement without waking providers. A window that cannot answer is reported explicitly.',
      input: z.object({}).strict(), output: z.object({ windows: z.array(z.object({ windowId: z.string(), owner: controlOwnerSchema.nullable(),
        workspace: workspaceObservationSchema.optional(), error: z.string().optional() })) }),
      handler: async (_input, context) => ({ windows: await observe(context) }),
    }),
    defineCapability({
      id: 'agents.search', title: 'Search agents across windows', execution: 'main', effect: 'read',
      description: 'Find existing agents across every window/project, including related, detached and buried agents. Results carry stable ownership for direct navigation. Incomplete windows are reported, never silently dropped.',
      input: z.object({ query: z.string().default(''), windowId: z.string().optional(), tabId: z.string().optional(),
        provider: z.string().optional(), placement: z.string().optional(), ...pageInput }).strict(),
      output: pageSchema(match).extend({ unavailableWindows: z.array(z.object({ windowId: z.string(), error: z.string() })) }),
      handler: async (input, context) => {
        const windows = (await observe(context)).filter(window => !input.windowId || window.windowId === input.windowId)
        const query = input.query.trim().toLocaleLowerCase()
        const rows = windows.flatMap(window => window.workspace && window.owner ? window.workspace.sessions.filter(session =>
          session.provider !== 'terminal' && (!input.provider || session.provider === input.provider)
          && (!input.tabId || session.placements.some(placement => placement.tabId === input.tabId))
          && (!input.placement || session.placements.some(placement => placement.kind === input.placement))
          && [session.sessionId, session.title, session.cwd, session.provider].some(value => value.toLocaleLowerCase().includes(query)))
          .map(session => ({ ...session, owner: window.owner! })) : [])
        const { cursor: _cursor, limit: _limit, ...filters } = input
        return { ...paginate(rows, input, `agents.search:${JSON.stringify(filters)}`),
          unavailableWindows: windows.filter(window => window.error).map(window => ({ windowId: window.windowId, error: window.error! })) }
      },
    }),
  ]
}
