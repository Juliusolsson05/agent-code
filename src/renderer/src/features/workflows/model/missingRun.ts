import type { WorkflowRunReference } from '../client/WorkflowClient'

/**
 * What to call a referenced workflow run that the store reports NOT FOUND
 * (#1348), shared by the run view and the history dialog so they agree.
 *
 * WHY this exists: history is built from transcript references, and those
 * outlive the run directory. Workflow retention (#1275) removes a run's stored
 * data after its window, so an old reference points at nothing. Both surfaces
 * used to present that as a fault ("Unknown", "not found" with a Retry) and the
 * run view kept Resume, which can only fail with run-not-found.
 *
 * WHY two labels: main answers `null` only for `run-not-found` in the scope it
 * was asked about (WorkflowBridge.getSnapshot). A reference that carries its
 * own `cwd` was looked up in the run's own project, so "not found" there means
 * its data is gone: Expired. The detail does NOT claim retention did it: a
 * project folder that was moved or renamed answers the same way, so it names
 * retention only as the usual cause. A reference WITHOUT a cwd was looked up in the
 * session's project instead, which proves only that it is not there, so it is
 * Unavailable. Claiming retention removed it would be a guess.
 *
 * WHY no day count in the text: the retention windows live in workflow-mcp and
 * differ by lineage (30 days resumable, 7 completed-only). A number copied here
 * would drift the first time they change.
 *
 * A failed READ is not "not found" and never comes through here: it stays an
 * error with Retry, and the reference's own actions stay available.
 */
export function missingRunCopy(reference: Pick<WorkflowRunReference, 'cwd'>): { label: string; detail: string } {
  return reference.cwd
    ? {
        label: 'Expired',
        detail: 'This run’s stored data is gone (workflow retention removes old runs). It can no longer be opened or resumed.',
      }
    : {
        label: 'Unavailable',
        detail: 'This run was not found in this project. It can no longer be opened or resumed here.',
      }
}
