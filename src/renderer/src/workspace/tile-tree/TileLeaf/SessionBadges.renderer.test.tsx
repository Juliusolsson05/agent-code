import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import recordedCodexWorktreeWindow from '../../../../../../testing/fixtures/worktree-live-attribution/codex-0151-worktree-window.json'
import recordedGitWorktrees from '../../../../../../testing/fixtures/worktree-live-attribution/git-worktree-identities.json'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'
import type {
  WorktreeActivityState,
  WorktreeIdentity,
} from '@shared/work-context/types'

import { WorktreeBadge } from './SessionBadges'

describe('WorktreeBadge recorded active projection', () => {
  it('shows the current Git branch for the recorded Codex worktree commands', () => {
    const fixture = recordedCodexWorktreeWindow as {
      git: {
        main: { path: string; branch: string }
        ui: { path: string; branch: string }
      }
      records: Array<Record<string, unknown>>
    }
    const worktrees = (recordedGitWorktrees as {
      worktrees: Array<{
        path: string
        branch: string
        detached: boolean
      }>
    }).worktrees.map(worktree => ({
      ...worktree,
      head: null,
    })) as WorktreeIdentity[]
    let activity: WorktreeActivityState | null = null
    for (const raw of fixture.records) {
      activity = ingestWorktreeRawEvent({
        state: activity,
        raw,
        worktrees,
        sessionCwd: fixture.git.main.path,
      })
    }

    render(
      <WorktreeBadge
        context={deriveAgentWorkContext(activity)}
        activity={activity}
      />,
    )

    // WHY assert the painted label, not only tracker state: #658 survived a
    // direct parser contract because the user's failure was at the chip. This
    // final projection proves the component prefers recorded active location
    // and renders Git's canonical worktree branch rather than launch main.
    const badge = screen.getByText(fixture.git.ui.branch)
    expect(badge).toHaveAttribute(
      'title',
      expect.stringContaining(`Worktree: ${fixture.git.ui.path}`),
    )
    expect(badge).toHaveAttribute(
      'title',
      expect.stringContaining('Active worktree'),
    )
  })
})
