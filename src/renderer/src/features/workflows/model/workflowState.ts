import type { WorkflowState } from 'workflow-mcp/state'

// These aliases intentionally derive from the package's one public state shape. The workflow-mcp
// reducer owns its internal snapshot type names; the renderer only needs indexed members. Deriving
// them here keeps a harmless package rename from rippling through every presentational component.
export type WorkflowAgentState = WorkflowState['agents'][number]
export type WorkflowPhaseState = WorkflowState['phases'][number]
export type WorkflowAttemptState = WorkflowAgentState['attempts'][number]
export type WorkflowActivityState = WorkflowAttemptState['activities'][number]
export type WorkflowContentReference = WorkflowAgentState['prompt']
