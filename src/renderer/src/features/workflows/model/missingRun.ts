import { useEffect, useRef, useState } from 'react'

import type { WorkflowClient, WorkflowRunReference } from '../client/WorkflowClient'
import { workflowRunActivity } from './workflowRunStatus'

/**
 * What to call a referenced workflow run that the store reports NOT FOUND
 * (#1348), shared by the run view, the selector and the history dialog so
 * they agree.
 *
 * WHY this exists: history is built from transcript references, and those
 * outlive the run directory. Workflow retention (#1275) removes a run's stored
 * data after its window, so an old reference points at nothing. The surfaces
 * used to present that as a fault ("Unknown", "not found" with a Retry), and
 * the run view kept Resume, which can only fail with run-not-found.
 *
 * WHY one label (#1440 review b): main answers `null` only for
 * `run-not-found`, and workflow-mcp looks the manifest up GLOBALLY by run id
 * before it checks the project scope (`WorkflowService.status`: a run in
 * another project is `scope-forbidden`, not null). So null always means the
 * run is gone from this app's store. The first version split it into
 * "Expired" and "Unavailable in this project" by whether the reference named
 * a cwd, which misdescribed the protocol.
 *
 * WHY the detail does not claim retention did it: a run folder removed by
 * hand answers the same way, so retention is named only as the usual cause.
 * No day count either: the windows live in workflow-mcp and differ by
 * lineage, and a copied number would drift.
 *
 * A failed READ is not "not found" and never comes through here: it stays an
 * error with Retry, and the reference's own actions stay available.
 */
export const MISSING_RUN = {
  label: 'Expired',
  detail: 'This run’s stored data is gone (workflow retention removes old runs). It can no longer be opened or resumed.',
} as const

/**
 * The run ids among `references` whose runs are gone, for the selector's tabs
 * (#1440 reviews a+b). A tab labels a run Active from its launch-time
 * reference status, so an expired `queued` run stayed Active beside a dialog
 * that said Expired. Only references that CLAIM to be active are checked: the
 * selector shows at most three, and an inactive claim needs no correction.
 *
 * WHY per run and not one batch (round-2 review b): the first version re-read
 * every visible tab through one Promise.all whenever the set changed. A later
 * transient failure on a tab already proven Expired then cleared it back to
 * Active, and one slow read held back another tab's answer. Now:
 *   - each run is asked ONCE, and its answer lands as soon as it arrives;
 *   - "missing" is never taken back (a failed read proves nothing);
 *   - a failed read is forgotten, so the run may be asked again on a later
 *     change of the visible set;
 *   - a result arriving after unmount is dropped.
 */
export function useMissingRunIds(
  client: WorkflowClient,
  references: readonly WorkflowRunReference[],
  cwd: string | null,
): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())
  const asked = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const claimsActive = references
    .filter(reference => workflowRunActivity(reference.status) === 'active' && (reference.cwd ?? cwd))
    .map(reference => `${reference.runId}\u0000${reference.cwd ?? cwd}`)
  const key = claimsActive.join('\u0001')
  // Answers belong to the client that gave them: a new client (rare) starts over.
  const answeredBy = useRef(client)
  useEffect(() => {
    if (answeredBy.current !== client) {
      answeredBy.current = client
      asked.current = new Set()
      setMissing(new Set())
    }
    if (!client.available) return
    for (const entry of claimsActive) {
      if (asked.current.has(entry)) continue
      asked.current.add(entry)
      const [runId, scopeCwd] = entry.split('\u0000') as [string, string]
      client.getSnapshot({ cwd: scopeCwd, runId }).then(snapshot => {
        if (snapshot !== null || !mounted.current || answeredBy.current !== client) return
        setMissing(previous => previous.has(runId) ? previous : new Set(previous).add(runId))
      }, () => { asked.current.delete(entry) })
    }
    // `key` is the content of claimsActive; the array itself is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key])
  return missing
}
