import type { WorktreeDump, WorktreeDumpRow } from '@renderer/features/worktrees/lib/loadWorktreeDump'

export function formatWorktreeDump(dump: WorktreeDump): string {
  const lines: string[] = [
    '# Worktree Status Dump',
    '',
    `Project cwd: ${dump.cwd ?? '(none)'}`,
    `Generated: ${new Date(dump.generatedAt).toLocaleString()}`,
    '',
  ]

  if (!dump.cwd) {
    lines.push('Status: no focused project cwd was available')
    return lines.join('\n')
  }

  if (dump.gitUnavailable) {
    lines.push('Status: not a Git repository or no worktree information is available')
    return lines.join('\n')
  }

  lines.push('## Summary')
  lines.push(`- Total worktrees: ${dump.rows.length}`)
  lines.push(`- Live: ${countRows(dump.rows, row => row.liveAgents.some(agent => agent.live))}`)
  lines.push(`- Dirty: ${countRows(dump.rows, row => row.dirty)}`)
  lines.push(`- Active/unmerged: ${countRows(dump.rows, row => row.category === 'active-unmerged')}`)
  lines.push(`- Cleanup/merged: ${countRows(dump.rows, row => row.category === 'cleanup-merged')}`)
  lines.push(`- Detached: ${countRows(dump.rows, row => row.detached)}`)
  lines.push(`- Agent activity: ${dump.activityUnavailable ? 'unavailable' : 'available'}`)
  if (dump.indexStatus?.lastIndexedAt) {
    lines.push(`- Activity index updated: ${new Date(dump.indexStatus.lastIndexedAt).toLocaleString()}`)
  }
  lines.push('')

  if (dump.rows.length === 0) {
    lines.push('## Worktrees')
    lines.push('')
    lines.push('No worktrees found.')
    return lines.join('\n')
  }

  lines.push('## Worktrees')
  for (const row of dump.rows) {
    lines.push('')
    lines.push(`### ${row.branch ?? '(detached)'}`)
    lines.push(`- Path: ${row.path}`)
    lines.push(`- Status: ${labelFor(row.liveAgents.some(agent => agent.live) ? 'live' : row.category)}`)
    lines.push(`- Dirty: ${row.dirty ? 'yes' : 'no'}`)
    if (row.ahead !== null && row.behind !== null) {
      lines.push(`- Ahead/behind main: +${row.ahead} / -${row.behind}`)
    } else {
      lines.push('- Ahead/behind main: unavailable')
    }
    lines.push(`- Last commit: ${row.lastCommitRelative ?? 'unavailable'}`)
    if (row.liveAgents.length > 0) {
      lines.push(`- Live/open agents: ${row.liveAgents.map(formatLiveAgent).join('; ')}`)
    } else {
      lines.push('- Live/open agents: none')
    }
    if (row.activity) {
      lines.push(
        `- Last indexed agent activity: ${providerLabel(row.activity.lastProvider)} ` +
          `${relativeTime(row.activity.lastActivityAt)} (${row.activity.lastSource})`,
      )
      lines.push(`- Last indexed agent session: ${row.activity.lastProviderSessionId}`)
      lines.push(
        `- Indexed activity counts: writes=${row.activity.eventCounts.writes}, ` +
          `commands=${row.activity.eventCounts.commands}, commits=${row.activity.eventCounts.commits}, ` +
          `pushes=${row.activity.eventCounts.pushes}, reads=${row.activity.eventCounts.reads}`,
      )
    } else {
      lines.push(
        `- Last indexed agent activity: ${dump.activityUnavailable ? 'unavailable' : 'none'}`,
      )
    }
  }

  return lines.join('\n')
}

export function formatWorktreeDumpPrompt(dump: WorktreeDump): string {
  return [
    'Please analyze this cc-shell worktree status dump.',
    '',
    'Help me decide:',
    '- which worktrees are active',
    '- which worktrees are cleanup candidates',
    '- which worktrees need review before removal',
    '- which worktrees have dirty or detached state that needs care',
    '',
    'Do not recommend deleting anything unless the dump clearly shows it is safe.',
    '',
    formatWorktreeDump(dump),
  ].join('\n')
}

function countRows(rows: WorktreeDumpRow[], predicate: (row: WorktreeDumpRow) => boolean): number {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0)
}

export function labelFor(category: string): string {
  if (category === 'live') return 'Live'
  if (category === 'dirty') return 'Dirty'
  if (category === 'active-unmerged') return 'Active'
  if (category === 'cleanup-merged') return 'Cleanup'
  if (category === 'detached') return 'Detached'
  if (category === 'main') return 'Main'
  return 'Review'
}

export function providerLabel(kind: 'claude' | 'codex'): string {
  return kind === 'codex' ? 'Codex' : 'Claude'
}

function formatLiveAgent(agent: WorktreeDumpRow['liveAgents'][number]): string {
  return `${providerLabel(agent.kind)} ${agent.live ? 'active' : 'open'} in "${agent.tabTitle}"`
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'in the future'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
