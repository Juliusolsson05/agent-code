import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GitBarStatusResult } from '@shared/types/gitStatus'
import { GitBar } from './GitBar'

// #1250 row 11: a git command that hit main's 5 s timeout used to read as "no
// output", so a slow repo showed "Not a Git repository." and a status whose
// diff or log timed out looked clean. The answers main now gives for a
// timeout (see ipc/git.timeout.test.ts) are shown for what they are.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function mount(status: GitBarStatusResult) {
  Object.defineProperty(window, 'api', { configurable: true, value: { gitStatus: vi.fn(async () => status) } })
  render(<GitBar cwd="/repo" onClose={() => {}} />)
}

describe('GitBar and a git timeout', () => {
  it('says a timed-out probe is a timeout, not "not a repository"', async () => {
    mount({ ok: false, gitMissing: false, timedOut: true })
    expect(await screen.findByText('Git took too long to answer here. It will try again.')).toBeTruthy()
    expect(screen.queryByText('Not a Git repository.')).toBeNull()
  })

  it('marks a status whose later commands timed out as possibly incomplete', async () => {
    mount({ ok: true, branch: 'feat', files: [], commits: [], incomplete: true })
    expect(await screen.findByText('Git took too long; this may be incomplete.')).toBeTruthy()
  })

  it('shows neither for a full answer, and still says "not a repository" for one', async () => {
    mount({ ok: true, branch: 'feat', files: [], commits: [] })
    expect(await screen.findByText('feat')).toBeTruthy()
    expect(screen.queryByText(/took too long/)).toBeNull()
    cleanup()
    mount({ ok: false, gitMissing: false })
    expect(await screen.findByText('Not a Git repository.')).toBeTruthy()
  })
})
