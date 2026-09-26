import type {
  AgentCodeInstalledSkillCandidate,
  AgentCodeInstalledSkillUpdateResult,
} from '@shared/types/agentCodeInstalledSkills'
import { withVisibleControls } from '@shared/text/visibleControls'

/**
 * The package review the user approves an install or update from. Moved
 * unchanged in substance from the retired Installed Skills row (#1161), so
 * the #1049 re-review rules below still hold: everything except the validated
 * skill NAME and the commit hash is repository-controlled text and is shown
 * with invisible characters made visible.
 */
export function CandidateDetails({ candidate }: { candidate: AgentCodeInstalledSkillCandidate }) {
  return (
    <div className="min-w-0 flex-1 text-[10px]">
      <div className="text-[12px] text-ink">
        {candidate.name}
        {candidate.internal ? <span className="ml-2 rounded-chip border border-border px-1 text-[10px] text-muted">internal</span> : null}
      </div>
      <div className="mt-1 text-muted">{withVisibleControls(candidate.description)}</div>
      <div className="mt-1 text-muted">
        {withVisibleControls(candidate.source.path) || 'repository root'} · {candidate.files.length} file{candidate.files.length === 1 ? '' : 's'} · {formatBytes(candidate.totalBytes)}
      </div>
      {candidate.warnings.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-warning">
          {/* A warning names the file it is warning ABOUT, so it is escaped
              like the file list (#1049 re-review). */}
          {candidate.warnings.map(warning => <li key={warning}>{withVisibleControls(warning)}</li>)}
        </ul>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted">Review package files</summary>
        <ul className="mt-1 max-h-40 overflow-auto border border-panel-border p-2 text-muted">
          {candidate.files.map(file => (
            <li key={file.path}>{file.executable ? 'executable · ' : ''}{withVisibleControls(file.path)} · {formatBytes(file.bytes)}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export type SkillUpdateReview = Extract<AgentCodeInstalledSkillUpdateResult, {
  ok: true
  kind: 'update-available'
}>

export function UpdateReviewPanel({ review }: { review: SkillUpdateReview }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="border border-panel-border p-3 text-[10px] text-muted">
        <div>{withVisibleControls(review.candidate.source.repositoryUrl)}</div>
        <div className="mt-1">New commit {review.candidate.source.resolvedCommit.slice(0, 12)}</div>
      </div>
      <div className="grid grid-cols-1 gap-2 text-[10px] md:grid-cols-3">
        <ChangeList title="Added" paths={review.changes.added} />
        <ChangeList title="Changed" paths={review.changes.changed} />
        <ChangeList title="Removed" paths={review.changes.removed} />
      </div>
      <CandidateDetails candidate={review.candidate} />
    </div>
  )
}

function ChangeList({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="border border-panel-border p-2">
      <div className="text-ink">{title} · {paths.length}</div>
      {paths.length > 0 ? <ul className="mt-1 space-y-1 text-muted">{paths.map(path => <li key={path}>{withVisibleControls(path)}</li>)}</ul> : null}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
