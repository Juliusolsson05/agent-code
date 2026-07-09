import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'

// Activity classification + palette for agent status surfaces.
//
// WHY this lives in its own module instead of DispatchAgentList.tsx where
// it grew up: the floating agent-status overlay is a SEPARATE renderer
// entry (src/renderer/src/overlay/) whose bundle must not drag in the full
// Dispatch component graph (workspace store, tile tree, provider
// capabilities...) just to color five dots. These helpers are the shared
// activity vocabulary across DispatchAgentList, DispatchMiniList, and the
// overlay — one source of truth so all three surfaces read identically.
// DispatchAgentList re-exports them, so its existing importers are
// untouched.

export type DispatchAgentActivity = 'working' | 'running' | 'idle' | 'exited' | 'starting'

// Exported for reuse by the Tiled Dispatch mini-list, which shows a
// compact activity dot derived from the same runtime state.
export function dispatchActivity(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
  processStatus?: string
}): DispatchAgentActivity {
  if (runtime.sessionStatus === undefined) return 'starting'
  if (isSessionExited(runtime)) return 'exited'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return 'working'
  if (runtime.sessionStatus === 'running') return 'running'
  return 'idle'
}

// Exported so the Tiled Dispatch mini-list can render its index chips with
// the exact same activity background + accent-when-selected palette as the
// main index's chip cell — the two surfaces must read identically.
export function dispatchActivityClasses(
  activity: DispatchAgentActivity,
  active: boolean,
): {
  row: string
  index: string
  title: string
} {
  // Dispatch is a dense scanning surface, so full-row status backgrounds
  // make every state compete with the actual content. The index cell is the
  // one stable visual affordance every row already has, which makes it the
  // right place for both active selection and process state. Active wins here
  // because it answers "where am I focused?" while the text metadata still
  // spells out whether the underlying session is running, working, or exited.
  if (active) {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-accent text-accent-fg',
      title: '',
    }
  }
  if (activity === 'working') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-success text-success-fg',
      title: '',
    }
  }
  if (activity === 'running') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-info text-info-fg',
      title: '',
    }
  }
  if (activity === 'starting') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-warning text-warning-fg',
      title: '',
    }
  }
  if (activity === 'exited') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-muted opacity-75',
      index: 'bg-danger text-danger-fg',
      title: '',
    }
  }
  return {
    row: 'bg-surface hover:bg-surface-hi text-ink-dim',
    index: 'bg-surface-hi text-muted',
    title: '',
  }
}

// Activity → dot color for the compact mini-list. Mirrors the index-cell
// palette in dispatchActivityClasses so the two surfaces read the same.
export function dispatchActivityDotClass(activity: DispatchAgentActivity): string {
  switch (activity) {
    case 'working':
      return 'bg-success'
    case 'running':
      return 'bg-info'
    case 'starting':
      return 'bg-warning'
    case 'exited':
      return 'bg-danger'
    default:
      return 'bg-muted'
  }
}
