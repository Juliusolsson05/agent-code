import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { loadWorktreeDump } from './lib/loadWorktreeDump'

export function worktreeControlCapabilities(getWorkspace: () => Workspace) {
  return [defineCapability({ id: 'worktrees.read', title: 'Read worktree status and agent activity', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
    description: 'Read the Worktrees panel data for an exact agent’s repository, including branch/path, Git status, indexed activity and associated live agents. Bounded pages use a revision; changing Git/activity state requires a fresh read. Explicitly reports missing Git, non-repository and activity-index unavailability. Does not create, delete or change worktrees, or wake agents.',
    input: z.object({ sessionId: z.string(), refreshActivity: z.boolean().default(false), ...pageInput }).strict(),
    output: pageSchema(z.json()).extend({ cwd: z.string(), generatedAt: z.number(), gitUnavailable: z.boolean(), gitMissing: z.boolean(), activityUnavailable: z.boolean(), indexStatus: z.json().nullable() }),
    handler: async input => {
      const workspace = getWorkspace(), meta = useAppStore.getState().workspaceState.sessions[input.sessionId]
      if (!meta) throw new ControlError('unavailable', 'Agent no longer exists')
      const dump = await loadWorktreeDump({ cwd: meta.cwd, workspace, forceActivityRefresh: input.refreshActivity })
      return { ...paginate(dump.rows.map(row => z.json().parse(JSON.parse(JSON.stringify(row)))), input, `worktrees:${input.sessionId}:${meta.cwd}`), cwd: meta.cwd,
        generatedAt: dump.generatedAt, gitUnavailable: dump.gitUnavailable, gitMissing: dump.gitMissing, activityUnavailable: dump.activityUnavailable,
        indexStatus: z.json().parse(JSON.parse(JSON.stringify(dump.indexStatus))) }
    },
  })]
}
