import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { useWorkflowClient } from '../client/WorkflowClientContext'
import {
  workflowRunActivity,
  workflowRunStatusLabel,
} from '../model/workflowRunStatus'

type WorkflowHistoryDetails = {
  status?: string
  createdAt?: string
  updatedAt?: string
  loading: boolean
  error?: boolean
}

const HISTORY_PAGE_SIZE = 50
const HISTORY_DETAIL_CONCURRENCY = 8

function workflowLabel(reference: WorkflowRunReference): string {
  return (
    reference.workflow?.title ??
    reference.workflow?.name ??
    `Workflow ${reference.runId.slice(0, 8)}`
  )
}

function timestampLabel(value: string): string | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function Timestamp({ label, value }: { label: string; value: string | undefined }) {
  const formatted = value ? timestampLabel(value) : null
  if (!value || !formatted) return null
  return (
    <span>
      {label}{' '}
      <time dateTime={value}>{formatted}</time>
    </span>
  )
}

async function readHistoryDetails(
  client: ReturnType<typeof useWorkflowClient>,
  reference: WorkflowRunReference,
  cwd: string | null,
): Promise<WorkflowHistoryDetails> {
  const effectiveCwd = reference.cwd ?? cwd
  if (!client.available || !effectiveCwd) {
    return { status: reference.status, loading: false }
  }

  try {
    const snapshot = await client.getSnapshot({ cwd: effectiveCwd, runId: reference.runId })
    const manifest = snapshot?.manifest
    // WHY a successful null clears launch-time status: transcript references are durable discovery
    // records, not durable status authority. If the corresponding manifest has been pruned, a
    // weeks-old `queued` tool result must become Unknown instead of claiming work is still Active.
    return {
      ...(manifest?.status ? { status: manifest.status } : {}),
      ...(manifest?.createdAt ? { createdAt: manifest.createdAt } : {}),
      ...(manifest?.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
      loading: false,
    }
  } catch {
    // WHY failures are distinct from a missing manifest: corrupt storage, forbidden scope, and an
    // IPC outage require user-visible recovery. Calling all of them "Timestamp unavailable" hid a
    // real operational fault and retained the same stale launch status as the missing-run path.
    return { loading: false, error: true }
  }
}

export function WorkflowHistoryDialog({
  open,
  onOpenChange,
  references,
  cwd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  references: readonly WorkflowRunReference[]
  cwd: string | null
}): React.JSX.Element {
  const client = useWorkflowClient()
  const [detailsByRunId, setDetailsByRunId] = useState<Record<string, WorkflowHistoryDetails>>({})
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE)
  const historyRegionRef = useRef<HTMLDivElement>(null)
  const newestFirst = useMemo(() => [...references].reverse(), [references])
  const visibleReferences = newestFirst.slice(0, visibleCount)

  useEffect(() => {
    if (!open) {
      setVisibleCount(HISTORY_PAGE_SIZE)
      return
    }
    let disposed = false
    const initial = Object.fromEntries(references.map(reference => [
      reference.runId,
      {
        status: reference.status,
        loading: client.available && Boolean(reference.cwd ?? cwd),
      },
    ]))
    setDetailsByRunId(initial)

    if (!client.available) return
    // WHY details load only when the user opens history: the compact selector may exist for the
    // lifetime of a busy agent, while each manifest read crosses IPC and touches durable storage.
    // The explicit history action is the point where timestamps and fresh terminal status become
    // valuable enough to pay that cost. Fixed-size batches cap both main-process storage pressure
    // and React commits: an old session with hundreds of runs must not create one concurrent IPC
    // read and one full details-map copy per row in a single burst.
    void (async () => {
      const loadable = references.filter(reference => Boolean(reference.cwd ?? cwd))
      for (let offset = 0; offset < loadable.length; offset += HISTORY_DETAIL_CONCURRENCY) {
        const batch = loadable.slice(offset, offset + HISTORY_DETAIL_CONCURRENCY)
        const details = await Promise.all(batch.map(reference => (
          readHistoryDetails(client, reference, cwd)
        )))
        if (disposed) return
        setDetailsByRunId(current => ({
          ...current,
          ...Object.fromEntries(batch.map((reference, index) => [reference.runId, details[index]])),
        }))
      }
    })()

    return () => {
      disposed = true
    }
  }, [client, cwd, open, references])

  const retryDetails = useCallback((reference: WorkflowRunReference) => {
    setDetailsByRunId(current => ({
      ...current,
      [reference.runId]: { loading: true },
    }))
    void readHistoryDetails(client, reference, cwd).then(details => {
      setDetailsByRunId(current => ({
        ...current,
        [reference.runId]: details,
      }))
    })
  }, [client, cwd])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[82vh] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden"
        onOpenAutoFocus={event => {
          // The history rows are read-only, so without an explicit focus target Radix can only
          // focus Close. Focusing the labeled scroll region lets PageUp/PageDown and arrow keys
          // reach every historical entry while Close remains the next ordinary tab stop.
          event.preventDefault()
          historyRegionRef.current?.focus()
        }}
      >
        <DialogHeader className="pr-12">
          <DialogTitle>Workflow history</DialogTitle>
          <DialogDescription>
            All workflow runs started by this session, newest first.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={historyRegionRef}
          role="region"
          aria-label="Workflow history entries"
          tabIndex={0}
          className="overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          <div role="list" aria-label="Previous workflow runs" className="space-y-2">
            {visibleReferences.map(reference => {
              const details = detailsByRunId[reference.runId] ?? {
                status: reference.status,
                loading: false,
              }
              const activity = workflowRunActivity(details.status)
              const activityLabel = activity === 'active'
                ? 'Active'
                : activity === 'inactive'
                  ? 'Inactive'
                  : 'Unknown'
              const statusLabel = workflowRunStatusLabel(details.status)
              return (
                <article
                  key={reference.runId}
                  role="listitem"
                  data-workflow-activity={activity}
                  className={`border border-border px-3 py-2.5 ${
                    activity === 'active'
                      ? 'bg-accent/10'
                      : activity === 'inactive'
                        ? 'bg-surface-hi/40'
                        : 'bg-surface'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-ink">
                        {workflowLabel(reference)}
                      </div>
                      <div className="mt-1 truncate font-code text-[10px] text-muted">
                        {reference.runId}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 border px-2 py-0.5 text-[10px] ${
                        activity === 'active'
                          ? 'border-accent/40 text-accent'
                          : 'border-border text-muted'
                      }`}
                    >
                      {activityLabel} · {statusLabel}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                    {details.loading ? (
                      <span>Loading timestamps…</span>
                    ) : details.error ? (
                      <span className="flex items-center gap-2" role="alert">
                        <span>Couldn’t load details</span>
                        <button
                          type="button"
                          onClick={() => retryDetails(reference)}
                          className="text-ink underline underline-offset-2 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
                        >
                          Retry
                        </button>
                      </span>
                    ) : details.createdAt ? (
                      <>
                        <Timestamp label="Started" value={details.createdAt} />
                        {details.updatedAt && details.updatedAt !== details.createdAt ? (
                          <Timestamp label="Updated" value={details.updatedAt} />
                        ) : null}
                      </>
                    ) : (
                      <span>Timestamp unavailable</span>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
          {visibleCount < newestFirst.length ? (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-[10px] text-muted">
              <span>Showing {visibleReferences.length} of {newestFirst.length}</span>
              <button
                type="button"
                onClick={() => setVisibleCount(current => current + HISTORY_PAGE_SIZE)}
                className="border border-border px-2 py-1 text-ink hover:border-border-hi hover:bg-surface-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
              >
                Show {Math.min(HISTORY_PAGE_SIZE, newestFirst.length - visibleCount)} more
              </button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
