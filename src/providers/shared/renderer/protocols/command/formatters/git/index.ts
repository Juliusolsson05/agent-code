import { detectGitIntent } from './detect'
import type { GitOperationModel } from './model'

/**
 * Admit a provider-normalized command to the rich Git formatter.
 *
 * Providers prove their envelope; this shared formatter proves only Git
 * command intent. There is deliberately no legacy feature toggle here. The
 * new renderer has not shipped yet, so keeping an off-switch for the old
 * in-PR comparison path would preserve dead architecture and make the
 * evidence catalog depend on a private setting instead of the payload.
 */
export function gitOperationModel(input: {
  command: string
  resultPresent: boolean
  output?: string
  isError: boolean
}): GitOperationModel | null {
  const intent = detectGitIntent(input.command)
  if (!intent) return null
  return {
    command: input.command,
    intent,
    status: !input.resultPresent
      ? 'running'
      : input.isError
        ? 'failure'
        : 'success',
    ...(input.resultPresent ? { output: input.output ?? '' } : {}),
  }
}

export { GitOperationView } from './GitOperationView'
export type { GitOperationModel } from './model'
