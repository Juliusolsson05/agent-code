export type WorkflowRunActivity = 'active' | 'inactive' | 'unknown'

const ACTIVE_STATUSES = new Set(['queued', 'pending', 'running', 'cancellation_requested'])
const INACTIVE_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'interrupted',
])

/**
 * Reduce the durable status vocabulary to the distinction the navigation needs.
 *
 * WHY unknown values stay unknown instead of defaulting to inactive: transcript-only references
 * can outlive their durable manifest, and future workflow-mcp versions may add a state this client
 * has not learned yet. Calling either case "inactive" would look reassuring while potentially
 * hiding live work. The UI gives unknown its own neutral treatment and explicit text.
 */
export function workflowRunActivity(status: string | undefined): WorkflowRunActivity {
  if (!status) return 'unknown'
  if (ACTIVE_STATUSES.has(status)) return 'active'
  if (INACTIVE_STATUSES.has(status)) return 'inactive'
  return 'unknown'
}

export function workflowRunStatusLabel(status: string | undefined): string {
  if (!status) return 'Status unavailable'
  return status.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase())
}
