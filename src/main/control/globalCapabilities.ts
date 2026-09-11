import { z } from 'zod'
import { controlOwnerSchema, defineCapability, pageInput, pageSchema, paginate, workspaceObservationSchema,
  type ControlContext, type ControlOwner } from '@control-sdk'
import { normalizeAgentName } from '@shared/agentNames/names.js'

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
      description: 'Find existing agents and terminals across every window/project, including related, detached and buried agents and terminals. Labels are window-local and may be ambiguous globally; all matching candidates are returned. Spoken agent names are application-wide and never recycled, but the same agent can still be observed by several windows. Results carry stable ownership for direct navigation. Incomplete windows are reported, never silently dropped.',
      // WHY the two free-text fields carry a length bound and `label` does not:
      // `label` is already pinned by a regex, but `name` and `query` are compared
      // — normalized, lowercased, substring-scanned — against every session of
      // every window on every call, so an unbounded string is a cheap way for one
      // request to make the search walk megabytes per agent. The bounds are far
      // past any real input: the longest allocatable name is a twelve-character
      // vocabulary entry plus an overflow ordinal ("Clementine 12"), and a useful
      // substring query is a handful of characters, never two hundred.
      input: z.object({ label: z.string().regex(/^[A-Za-z]+[1-9]\d*$/).optional().describe('Exact visible label, e.g. C18. Scope with windowId; global matches may identify different agents in different windows. Resolve to a stable ID before acting.'),
        name: z.string().trim().min(1).max(120).optional().describe('Exact spoken agent name from the Agent names setting, e.g. "Apollo" or "Apollo 2". Case-insensitive and whitespace-normalized, never a substring; use query for partial text. Names are absent while the setting is off, in which case this matches nothing. A name identifies one allocation, but several windows can observe the same agent, so every candidate is still returned — resolve to sessionId before acting.'), query: z.string().max(200).default('').describe('Case-insensitive substring of agent ID, visible label, spoken agent name, displayed/stored title, directory or provider. Empty searches all agents and terminals.'), windowId: z.string().optional().describe('Optional stable window ID from app.windows to restrict the cross-window search.'), tabId: z.string().optional().describe('Optional project tab ID from app.observe.'),
        provider: z.enum(['claude', 'codex', 'opencode']).optional().describe('Restrict to one provider.'), placement: z.enum(['grid', 'related', 'dispatch', 'detached', 'buried', 'reader', 'spotlight']).optional().describe('Restrict to agents with this placement; mirrored placements still identify the same agent.'), ...pageInput }).strict(),
      output: pageSchema(match).extend({ unavailableWindows: z.array(z.object({ windowId: z.string(), error: z.string() })) }),
      handler: async (input, context) => {
        const windows = (await observe(context)).filter(window => !input.windowId || window.windowId === input.windowId)
        const query = input.query.trim().toLocaleLowerCase()
        // Normalized once, outside the row loop: the same spoken-equivalence
        // rule the registry uses for uniqueness must decide a match, or a name
        // that cannot be allocated twice could still be searched for twice.
        const wantedName = input.name ? normalizeAgentName(input.name) : ''
        // WHY terminals are no longer excluded (#865): a shell is a session an
        // operator can find, locate, title and pin exactly like an agent — the
        // provider-only line belongs to agents.prompt, which draws it itself.
        const rows = windows.flatMap(window => window.workspace && window.owner ? window.workspace.sessions.filter(session =>
          (!input.label || session.displayLabel === input.label.toUpperCase())
          && (!wantedName || normalizeAgentName(session.agentName ?? '') === wantedName) && (!input.provider || session.provider === input.provider)
          && (!input.tabId || session.placements.some(placement => placement.tabId === input.tabId))
          && (!input.placement || session.placements.some(placement => placement.kind === input.placement))
          && [session.sessionId, session.title, session.displayedTitle, session.displayLabel ?? '', session.agentName ?? '', session.cwd, session.provider].some(value => value.toLocaleLowerCase().includes(query)))
          .map(session => ({ ...session, owner: window.owner! })) : [])
        const { cursor: _cursor, limit: _limit, ...filters } = input
        return { ...paginate(rows, input, `agents.search:${JSON.stringify(filters)}`),
          unavailableWindows: windows.filter(window => window.error).map(window => ({ windowId: window.windowId, error: window.error! })) }
      },
    }),
  ]
}
