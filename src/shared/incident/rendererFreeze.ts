export type RendererFreezeHeartbeat = {
  sentAt: number
  monotonicMs: number
  eventLoopLagMs: number
  visibilityState: 'visible' | 'hidden' | 'prerender'
  longTasks: {
    count: number
    totalMs: number
    maxMs: number
  }
  heap?: {
    usedBytes: number
    totalBytes: number
    limitBytes: number
  }
  /**
   * Sampled only every few heartbeats. Counting DOM nodes on every tick would make diagnostics
   * contribute measurable work to exactly the large-render-tree failure it is intended to catch.
   */
  dom?: {
    nodes: number
    preElements: number
    codeElements: number
    workflowActivities: number
  }
}
