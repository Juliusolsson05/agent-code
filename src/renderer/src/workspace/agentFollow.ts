import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'

type FollowRuntime = Pick<SessionRuntime, 'tailMode' | 'sessionStatus' | 'streamPhase' | 'exited' | 'processStatus'>
type FollowModes = { tailAllMode: boolean; tailWorkingMode: boolean }

export function isWorkingAgent(kind: string | undefined, runtime: FollowRuntime): boolean {
  // Match the composer Stop/running-count signals: a submitted prompt is busy
  // before its first semantic token, and a pending tool can keep the stream
  // busy between provider requests. Process existence alone is not work.
  // Exit/failure wins over stale stream state, and a shell never qualifies just
  // because a command happens to be running in it. Missing kind is legacy Claude.
  return isAgentProviderKind(kind ?? DEFAULT_PROVIDER)
    && !isSessionExited(runtime)
    && runtime.processStatus !== 'failed'
    && runtime.sessionStatus !== 'exited'
    && (runtime.sessionStatus === 'running' || runtime.streamPhase !== 'idle')
}

export function agentFollowEnabled(kind: string | undefined, runtime: FollowRuntime, modes: FollowModes): boolean {
  // Resolve the policy on each observation instead of stamping per-session
  // flags when the command runs. New work starts following automatically and
  // idle sessions regain their individual preferences. Both view surfaces and
  // command/control reporting use this rule so their On state stays truthful.
  // Visibility belongs to each mounted view, which masks this result separately.
  return runtime.tailMode || modes.tailAllMode || (modes.tailWorkingMode && isWorkingAgent(kind, runtime))
}
