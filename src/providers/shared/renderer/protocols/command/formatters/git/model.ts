import type { GitIntent } from './detect'

/** Provider-neutral terminal model for the Git command formatter. */
export type GitOperationModel = {
  command: string
  intent: GitIntent
  status: 'running' | 'success' | 'failure'
  output?: string
}
