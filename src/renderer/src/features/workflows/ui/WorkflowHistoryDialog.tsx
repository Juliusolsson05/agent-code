import { useEffect, useMemo, useState } from 'react'

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
}

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
  const newestFirst = useMemo(() => [...references].reverse(), [references])

  useEffect(() => {
    if (!open) return
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
    // valuable enough to pay that cost. Each row settles independently so one pruned run cannot
    // withhold the rest of the session's history.
    for (const reference of references) {
      const effectiveCwd = reference.cwd ?? cwd
      if (!effectiveCwd) continue
      void client.getSnapshot({ cwd: effectiveCwd, runId: reference.runId })
        .then(snapshot => {
          if (disposed) return
          const manifest = snapshot?.manifest
          setDetailsByRunId(current => ({
            ...current,
            [reference.runId]: {
              status: manifest?.status ?? reference.status,
              ...(manifest?.createdAt ? { createdAt: manifest.createdAt } : {}),
              ...(manifest?.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
              loading: false,
            },
          }))
        })
        .catch(() => {
          if (disposed) return
          // Historical references legitimately survive manual run-store cleanup. Preserve the
          // launch metadata and mark time as unavailable instead of turning one absent manifest
          // into a dialog-wide error that obscures healthy entries.
          setDetailsByRunId(current => ({
            ...current,
            [reference.runId]: { status: reference.status, loading: false },
          }))
        })
    }

    return () => {
      disposed = true
    }
  }, [client, cwd, open, references])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[82vh] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden"
      >
        <DialogHeader className="pr-12">
          <DialogTitle>Workflow history</DialogTitle>
          <DialogDescription>
            All workflow runs started by this session, newest first.
          </DialogDescription>
        </DialogHeader>

        <div role="list" aria-label="Previous workflow runs" className="overflow-y-auto p-3">
          <div className="space-y-2">
            {newestFirst.map(reference => {
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
