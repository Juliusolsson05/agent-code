import type {
  AgentWorkContext,
  WorktreeActivityEvent,
  WorktreeActivityState,
  WorktreeIdentity,
} from '@shared/work-context/types'
import { extractWorktreeActivityEvents } from '@shared/work-context/extractors'
import {
  contextFromPath,
  fallbackContext,
  matchWorktree,
} from '@shared/work-context/matching'
import { confidenceRank } from '@shared/work-context/scoring'

const TIMELINE_LIMIT = 120
const RECENT_KEY_LIMIT = 300

export function emptyWorktreeActivityState(now = Date.now()): WorktreeActivityState {
  return {
    active: null,
    primary: null,
    touched: {},
    timeline: [],
    recentKeys: [],
    updatedAt: now,
  }
}

export function seedWorktreeActivityFromContext(
  context: AgentWorkContext | null,
  now = Date.now(),
): WorktreeActivityState {
  const state = emptyWorktreeActivityState(now)
  if (!context?.worktreePath) return state
  const score = confidenceRank[context.confidence]
  return {
    ...state,
    active: context,
    primary: context,
    touched: {
      [context.worktreePath]: {
        worktreePath: context.worktreePath,
        branch: context.branch,
        score,
        lastAt: context.updatedAt,
        eventCount: 1,
        writeCount: 0,
        commandCount: 0,
        source: context.source,
      },
    },
  }
}

export function ingestWorktreeRawEvent(params: {
  state: WorktreeActivityState | null
  raw: unknown
  worktrees: WorktreeIdentity[]
  sessionCwd: string
  now?: number
}): WorktreeActivityState {
  const now = params.now ?? Date.now()
  let state = params.state ?? emptyWorktreeActivityState(now)
  const events = extractWorktreeActivityEvents(params.raw, now)
  if (events.length === 0) return state

  for (const event of events) {
    state = ingestWorktreeActivityEvent({
      state,
      event,
      worktrees: params.worktrees,
      sessionCwd: params.sessionCwd,
      now,
    })
  }
  return state
}

export function ingestWorktreeActivityEvent(params: {
  state: WorktreeActivityState
  event: WorktreeActivityEvent
  worktrees: WorktreeIdentity[]
  sessionCwd: string
  now?: number
}): WorktreeActivityState {
  const { event, worktrees, sessionCwd } = params
  const now = params.now ?? event.ts
  if (params.state.recentKeys.includes(event.key)) return params.state

  if (event.kind === 'worktree-exit') {
    const fallback = fallbackContext(
      sessionCwd,
      worktrees,
      now,
      event.source,
    )
    if (!fallback) return rememberEvent(params.state, event, now)
    const nextState = rememberEvent(params.state, event, now)
    return {
      ...nextState,
      active: { ...fallback, confidence: 'medium', source: event.source },
      primary: { ...fallback, confidence: 'medium', source: event.source },
      updatedAt: now,
    }
  }

  const matched = matchWorktree(event.path, worktrees)
  if (event.requiresWorktreeMatch && !matched) return params.state

  const context = contextFromPath({
    path: event.path,
    branch: event.branch,
    confidence: event.confidence,
    source: event.source,
    worktrees,
    now,
  })
  if (!context.worktreePath) return params.state

  const previousTouch = params.state.touched[context.worktreePath]
  const nextScore = (previousTouch?.score ?? 0) + event.primaryWeight
  const nextTouch = {
    worktreePath: context.worktreePath,
    branch: context.branch,
    score: nextScore,
    lastAt: now,
    eventCount: (previousTouch?.eventCount ?? 0) + 1,
    writeCount:
      (previousTouch?.writeCount ?? 0) +
      (event.kind === 'file-write' ? 1 : 0),
    commandCount:
      (previousTouch?.commandCount ?? 0) +
      (event.command ? 1 : 0),
    source: event.source,
  }
  const touched = {
    ...params.state.touched,
    [context.worktreePath]: nextTouch,
  }
  const nextState = rememberEvent({
    ...params.state,
    touched,
  }, event, now)

  const currentPrimaryPath = nextState.primary?.worktreePath ?? null
  const currentPrimaryScore =
    currentPrimaryPath ? touched[currentPrimaryPath]?.score ?? 0 : 0
  const shouldReplacePrimary =
    event.kind === 'worktree-enter' ||
    !nextState.primary ||
    (event.primaryWeight > 0 && nextScore > currentPrimaryScore) ||
    (
      event.primaryWeight > 0 &&
      nextScore === currentPrimaryScore &&
      confidenceRank[context.confidence] >=
        confidenceRank[nextState.primary.confidence]
    )

  return {
    ...nextState,
    active: event.active ? context : nextState.active,
    primary: shouldReplacePrimary ? context : nextState.primary,
    updatedAt: now,
  }
}

export function withFallbackWorktreeActivity(params: {
  state: WorktreeActivityState | null
  sessionCwd: string
  worktrees: WorktreeIdentity[]
  now?: number
  source?: string
}): WorktreeActivityState {
  const now = params.now ?? Date.now()
  const state = params.state ?? emptyWorktreeActivityState(now)
  if (state.primary || state.active) return state
  const fallback = fallbackContext(
    params.sessionCwd,
    params.worktrees,
    now,
    params.source ?? 'fallback:session-cwd:worktree-cache',
  )
  if (!fallback) return state
  return {
    ...state,
    active: fallback,
    primary: fallback,
    updatedAt: now,
  }
}

export function canonicalizeWorktreeActivity(
  state: WorktreeActivityState,
  worktrees: WorktreeIdentity[],
): WorktreeActivityState {
  return {
    ...state,
    active: canonicalizeContext(state.active, worktrees),
    primary: canonicalizeContext(state.primary, worktrees),
  }
}

export function deriveAgentWorkContext(
  state: WorktreeActivityState | null,
): AgentWorkContext | null {
  return state?.primary ?? state?.active ?? null
}

function rememberEvent(
  state: WorktreeActivityState,
  event: WorktreeActivityEvent,
  now: number,
): WorktreeActivityState {
  return {
    ...state,
    timeline: [...state.timeline, event].slice(-TIMELINE_LIMIT),
    recentKeys: [...state.recentKeys, event.key].slice(-RECENT_KEY_LIMIT),
    updatedAt: now,
  }
}

function canonicalizeContext(
  context: AgentWorkContext | null,
  worktrees: WorktreeIdentity[],
): AgentWorkContext | null {
  if (!context?.worktreePath) return context
  const matched = matchWorktree(context.worktreePath, worktrees)
  if (!matched) return context
  return {
    ...context,
    worktreePath: matched.path,
    branch: context.branch ?? matched.branch,
    repoRoot: worktrees[0]?.path ?? context.repoRoot,
  }
}
