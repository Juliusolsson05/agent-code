import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { WorktreeDump, WorktreeDumpRow } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import { relativeTime } from '@renderer/lib/relativeTime'

export function formatWorktreeDump(dump: WorktreeDump): string {
  const lines: string[] = [
    '# Worktree Status Dump',
    '',
    `Project cwd: ${dump.cwd ?? '(none)'}`,
    // #495 A15: toISOString, not toLocaleString — dump text is saved and
    // pasted across machines, and locale+timezone-dependent output made
    // byte-identical worktree states diff. (Row-level relativeTime()
    // usages stay locale-free and ephemeral-UI-only, so they're fine.)
    `Generated: ${new Date(dump.generatedAt).toISOString()}`,
    '',
  ]

  if (!dump.cwd) {
    lines.push('Status: no focused project cwd was available')
    return lines.join('\n')
  }

  if (dump.gitUnavailable) {
    // Mirror the WorktreesBar/GitBar copy split (#495 A5): this dump gets
    // pasted into bug reports, where "not a Git repository" on a machine
    // with no usable git would send the reader down the wrong path.
    lines.push(
      dump.gitMissing
        ? 'Status: no usable git executable on this machine — Git features disabled'
        : 'Status: not a Git repository or no worktree information is available',
    )
    return lines.join('\n')
  }

  lines.push('## Summary')
  lines.push(`- Total worktrees: ${dump.rows.length}`)
  lines.push(`- Live: ${countRows(dump.rows, row => row.liveAgents.some(agent => agent.live))}`)
  lines.push(`- Dirty: ${countRows(dump.rows, row => row.dirty)}`)
  lines.push(`- Active/unmerged: ${countRows(dump.rows, row => row.category === 'active-unmerged')}`)
  lines.push(`- Stale/review: ${countRows(dump.rows, row => row.category === 'stale-review')}`)
  lines.push(`- Patch-equivalent: ${countRows(dump.rows, row => row.category === 'patch-equivalent')}`)
  lines.push(`- Cleanup/merged: ${countRows(dump.rows, row => row.category === 'cleanup-merged')}`)
  lines.push(`- Detached: ${countRows(dump.rows, row => row.detached)}`)
  lines.push(`- Agent activity: ${dump.activityUnavailable ? 'unavailable' : 'available'}`)
  if (dump.indexStatus?.lastIndexedAt) {
    // Same #495 A15 rationale as the Generated line above.
    lines.push(`- Activity index updated: ${new Date(dump.indexStatus.lastIndexedAt).toISOString()}`)
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
    if (row.patchUniqueAhead !== null) {
      lines.push(`- Patch-unique commits: ${row.patchUniqueAhead}`)
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
    'Please analyze this Agent Code worktree status dump.',
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
  if (category === 'stale-review') return 'Review'
  if (category === 'patch-equivalent') return 'Patch-equivalent'
  if (category === 'cleanup-merged') return 'Cleanup'
  if (category === 'detached') return 'Detached'
  if (category === 'main') return 'Main'
  return 'Review'
}

export function providerLabel(kind: AgentProviderKind): string {
  // Registry-derived (#394 phase 2c-2).
  return getRendererProviderCapabilities(kind).shortLabel
}

function formatLiveAgent(agent: WorktreeDumpRow['liveAgents'][number]): string {
  return `${providerLabel(agent.kind)} ${agent.live ? 'active' : 'open'} in "${agent.tabTitle}"`
}
