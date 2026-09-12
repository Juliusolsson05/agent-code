import { describe, expect, it } from 'vitest'

import {
  buildProjectScopeRows,
  filterProjectScopeRows,
  rowsInSelectedProjects,
} from '@renderer/features/workspace/lib/projectScope'

// The workspace that surfaced #908: three tabs titled agent-code, agents spread
// over the main checkout and worktrees, plus an unrelated project.
const rows = [
  { sessionId: 'audit', tabId: 'tab-a', tabIndex: 0, tabTitle: 'agent-code', cwd: '/dev/agent-code' },
  { sessionId: 'grok', tabId: 'tab-a', tabIndex: 0, tabTitle: 'agent-code', cwd: '/dev/agent-code/.worktrees/grok-package-wiring' },
  { sessionId: 'terminal-headless', tabId: 'tab-a', tabIndex: 0, tabTitle: 'agent-code', cwd: '/dev/agent-code/.worktrees/opencode-terminal-headless' },
  { sessionId: 'startup', tabId: 'tab-b', tabIndex: 1, tabTitle: 'startup', cwd: '/dev/startup' },
  { sessionId: 'export-review', tabId: 'tab-c', tabIndex: 2, tabTitle: 'agent-code', cwd: '/dev/agent-code/.worktrees/opencode-export-integrity' },
]

describe('project scope rows', () => {
  it('keeps worktree agents under their tab and names tabs the way Dispatch does', () => {
    const projects = buildProjectScopeRows(rows, rows.filter(row => row.sessionId !== 'grok'))

    // The failure this pins: one entry per working directory, so "agent-code"
    // became four pseudo-projects and no scope meant "everyone in this tab".
    expect(projects.map(project => project.label)).toEqual(['A · agent-code', 'B · startup', 'C · agent-code'])
    expect(projects[0]).toMatchObject({
      tabId: 'tab-a',
      total: 3,
      matching: 2,
      directories: ['agent-code', 'grok-package-wiring', 'opencode-terminal-headless'],
    })
    expect(projects[2]).toMatchObject({ tabId: 'tab-c', total: 1, matching: 1, directories: ['opencode-export-integrity'] })
  })

  it('orders by tab, not by count', () => {
    const projects = buildProjectScopeRows([...rows].reverse(), [])
    expect(projects.map(project => project.tabIndex)).toEqual([0, 1, 2])
    expect(projects.every(project => project.matching === 0)).toBe(true)
  })

  it('finds a project by its worktree name and filters membership by tab', () => {
    const projects = buildProjectScopeRows(rows, rows)
    expect(filterProjectScopeRows(projects, 'grok').map(project => project.tabId)).toEqual(['tab-a'])
    expect(filterProjectScopeRows(projects, 'AGENT-CODE').map(project => project.tabId)).toEqual(['tab-a', 'tab-c'])
    expect(filterProjectScopeRows(projects, 'c ·').map(project => project.tabId)).toEqual(['tab-c'])
    expect(rowsInSelectedProjects(rows, new Set(['tab-a'])).map(row => row.sessionId))
      .toEqual(['audit', 'grok', 'terminal-headless'])
  })
})
