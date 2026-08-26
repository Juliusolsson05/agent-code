import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { useWorkflowClient } from '../client/WorkflowClientContext'

type ScopedReferences = {
  scopeKey: string
  references: WorkflowRunReference[]
}

const MAX_VISIBLE_WORKFLOW_VIEWS = 3

function mergeReferences(
  ...sources: ReadonlyArray<readonly WorkflowRunReference[]>
): WorkflowRunReference[] {
  const order: string[] = []
  const byRunId = new Map<string, WorkflowRunReference>()

  for (const source of sources) {
    for (const reference of source) {
      const previous = byRunId.get(reference.runId)
      if (!previous) order.push(reference.runId)
      byRunId.set(reference.runId, {
        ...previous,
        ...reference,
        ...(reference.workflow ?? previous?.workflow
          ? { workflow: reference.workflow ?? previous?.workflow }
          : {}),
      })
    }
  }

  // WHY resumed parents disappear from navigation instead of becoming another row: the workflow
  // service quite correctly creates immutable runs for every resume, while the product presents
  // one selectable workflow lineage. Transcript recovery can see both envelopes even when the
  // main-process session registry has already collapsed them, so the renderer must preserve that
  // invariant while merging its two discovery planes.
  const superseded = new Set<string>()
  for (const reference of byRunId.values()) {
    if (reference.resumedFromRunId && byRunId.has(reference.resumedFromRunId)) {
      superseded.add(reference.resumedFromRunId)
    }
  }

  const lineageReferences = order
    .filter(runId => !superseded.has(runId))
    .map(runId => byRunId.get(runId)!)

  // WHY the limit belongs after source reconciliation rather than in the visual selector: the
  // selected run, selected reference, and rendered tabs must all describe the same collection.
  // Hiding old rows only in JSX would leave an invisible workflow selected after a fourth run
  // arrived. The sources already establish stable oldest-to-newest discovery order, so retaining
  // the tail gives the UI its three newest lineages without inventing timestamp semantics that the
  // provider-neutral reference envelope does not carry.
  return lineageReferences.slice(-MAX_VISIBLE_WORKFLOW_VIEWS)
}

/**
 * Own the workflow-view navigation state for one session pane.
 *
 * WHY discovery merges transcript references with IPC registration: the transcript is durable and
 * survives renderer/app restarts, but trails a just-finished MCP call; the scoped main-process push
 * is immediate, but intentionally lives only as long as the host process. Neither is a sufficient
 * UI source by itself. Run IDs make the overlap safe and keep the shell independent of how Claude
 * or Codex chose to display the original tool call.
 */
export function useSessionWorkflowViews({
  sessionId,
  cwd,
  transcriptReferences,
}: {
  sessionId: string
  cwd: string | null
  transcriptReferences: readonly WorkflowRunReference[]
}): {
  references: WorkflowRunReference[]
  selectedRunId: string | null
  selectedReference: WorkflowRunReference | null
  selectRun: (runId: string | null) => void
  replaceReference: (reference: WorkflowRunReference) => void
} {
  const client = useWorkflowClient()
  const scopeKey = `${sessionId}\u0000${cwd ?? ''}`
  const [transport, setTransport] = useState<ScopedReferences>({
    scopeKey: '',
    references: [],
  })
  const [replacements, setReplacements] = useState<ScopedReferences>({
    scopeKey: '',
    references: [],
  })
  const [selection, setSelection] = useState<{ scopeKey: string; runId: string | null }>({
    scopeKey,
    runId: null,
  })

  const transportReferences = transport.scopeKey === scopeKey ? transport.references : []
  const replacementReferences = replacements.scopeKey === scopeKey ? replacements.references : []
  const references = useMemo(
    () => mergeReferences(transcriptReferences, transportReferences, replacementReferences),
    [replacementReferences, transcriptReferences, transportReferences],
  )
  const selectedRunId = selection.scopeKey === scopeKey ? selection.runId : null
  const selectedReference = selectedRunId === null
    ? null
    : references.find(reference => reference.runId === selectedRunId) ?? null

  useEffect(() => {
    if (!client.available || !cwd) return
    let disposed = false
    let receivedPush = false

    const accept = (references: WorkflowRunReference[]): void => {
      if (disposed) return
      setTransport({ scopeKey, references })
    }

    // Subscribe before the initial read. A workflow can start in the small window while the IPC
    // request is in flight; letting a slower list response overwrite that push would make the row
    // flash into existence and then disappear until another run event happened.
    const unsubscribe = client.subscribeSessionRuns(snapshot => {
      if (snapshot.sessionId !== sessionId || snapshot.cwd !== cwd) return
      receivedPush = true
      accept(snapshot.runs)
    })
    void client.listSessionRuns({ sessionId, cwd }).then(references => {
      if (!receivedPush) accept(references)
    }).catch(error => {
      // Workflow navigation is an enhancement over a still-usable Main feed. Keep a transient IPC
      // failure local and diagnosable without turning an agent pane into an unhandled rejection.
      console.warn('[workflows] could not list session runs', error)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [client, cwd, scopeKey, sessionId])

  useEffect(() => {
    if (selectedRunId === null || selectedReference) return
    // A session switch or lineage replacement must never leave a blank viewport selected. Main is
    // the safe fallback until the corresponding run reference is observable again.
    setSelection({ scopeKey, runId: null })
  }, [scopeKey, selectedReference, selectedRunId])

  const selectRun = useCallback((runId: string | null) => {
    setSelection({ scopeKey, runId })
  }, [scopeKey])

  const replaceReference = useCallback((reference: WorkflowRunReference) => {
    setReplacements(current => {
      const currentReferences = current.scopeKey === scopeKey ? current.references : []
      return {
        scopeKey,
        references: [
          ...currentReferences.filter(candidate => (
            candidate.runId !== reference.runId &&
            candidate.runId !== reference.resumedFromRunId
          )),
          reference,
        ],
      }
    })
    setSelection({ scopeKey, runId: reference.runId })
  }, [scopeKey])

  return {
    references,
    selectedRunId,
    selectedReference,
    selectRun,
    replaceReference,
  }
}
