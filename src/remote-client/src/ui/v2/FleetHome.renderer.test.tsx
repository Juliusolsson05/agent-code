import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UsageSnapshot } from '@shared/types/usage'
import type { WebSocketSessionFeed } from '../../WebSocketSessionFeed'
import { FleetHome } from './FleetHome'

// FleetHome is the v2 home screen: project grouping, pinned-first
// ordering, identity from the projection (spoken name > title > cwd),
// provider badges from identity descriptors, the TLDR one-line glance,
// and the long-press peek gesture.

type Summary = Parameters<typeof FleetHome>[0]['feed'] extends never ? never : never
void (undefined as Summary as never)

function fakeFeed(options: {
  summaries?: Array<Record<string, unknown>>
  tldr?: Record<string, { text: string; updatedAt: string; revision: number }>
  usage?: UsageSnapshot | null
}) {
  const summaries = (options.summaries ?? []) as never[]
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const on = (name: string) => (cb: (value: unknown) => void) => {
    let set = listeners.get(name)
    if (!set) listeners.set(name, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }
  return {
    getSessionList: () => summaries,
    onSessionList: on('onSessionList'),
    onSessionProcessState: on('onSessionProcessState'),
    onUsage: on('onUsage'),
    getUsage: () => options.usage ?? null,
    getTldrRecord: (sessionId: string) => options.tldr?.[sessionId] ?? null,
    getGoalRecord: () => null,
    onTldrChanged: () => () => {},
    onGoalChanged: () => () => {},
  } as unknown as WebSocketSessionFeed
}

const BASE = { alive: true, cwd: '/dev/agent-code', lastActivityAt: Date.now() - 120_000 }

describe('FleetHome', () => {
  it('groups by tabTitle with pinned first and renders identity + TLDR line', () => {
    const feed = fakeFeed({
      summaries: [
        { ...BASE, sessionId: 's1', kind: 'opencode', agentName: 'Apollo', tabTitle: 'agent-code', pinned: true, title: 'Shell rewrite', subAgentCount: 2 },
        { ...BASE, sessionId: 's2', kind: 'claude', title: 'Feed fix', tabTitle: 'agent-code' },
        { ...BASE, sessionId: 's3', kind: 'codex', cwd: '/dev/other', lastActivityAt: Date.now() - 3_600_000 },
        { ...BASE, sessionId: 's4', kind: 'claude', alive: false, tabTitle: 'agent-code' },
      ],
      tldr: { s1: { text: 'Rebuilding the shell renderer\nsecond line', updatedAt: '2026-09-17T10:00:00Z', revision: 2 } },
    })
    render(<FleetHome feed={feed} connection="open" onSelect={() => {}} onUnpair={() => {}} />)

    // Spoken name wins over title; TLDR line is the first line only.
    expect(screen.getByText('Apollo')).toBeTruthy()
    expect(screen.getByText('Rebuilding the shell renderer')).toBeTruthy()
    // Sub-agent count surfaced on the row.
    expect(screen.getByText('+2')).toBeTruthy()
    // Pinned flag on the pinned row.
    expect(screen.getByText('pinned')).toBeTruthy()
    // Group label from the projection; exited rows sink to their section
    // (the section label AND the dead row's own status both read 'exited').
    const groups = screen.getAllByText('agent-code')
    expect(groups.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('exited').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps its arrangement when the feed republishes the same sessions (#T18)', () => {
    // The phone bug the owner reported: "flashing, switching positions for
    // the agent index like a million times". Two agents working at once get
    // activity stamps a millisecond apart or identical, and the feed
    // republishes the list; with no tiebreak the rows landed in whatever
    // order the rebuilt array happened to carry, and whole GROUPS moved
    // because their order was Map insertion order.
    //
    // Same sessions, same stamps, two different array orders: the rendered
    // arrangement must be identical.
    const stamp = Date.now() - 10_000
    const rows = [
      { ...BASE, sessionId: 's-b', kind: 'claude', title: 'Beta', tabTitle: 'project-two', lastActivityAt: stamp },
      { ...BASE, sessionId: 's-a', kind: 'claude', title: 'Alpha', tabTitle: 'project-one', lastActivityAt: stamp },
      { ...BASE, sessionId: 's-c', kind: 'claude', title: 'Gamma', tabTitle: 'project-one', lastActivityAt: stamp },
    ]
    const arrangement = (summaries: Array<Record<string, unknown>>): string => {
      const view = render(<FleetHome feed={fakeFeed({ summaries })} connection="open" onSelect={() => {}} onUnpair={() => {}} />)
      const text = [...view.container.querySelectorAll('.session-row')]
        .map(row => row.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .join(' | ')
      view.unmount()
      return text
    }
    expect(arrangement(rows)).toBe(arrangement([...rows].reverse()))
  })

  it('opens the TLDR peek on long-press and navigates on tap', () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const feed = fakeFeed({
      summaries: [{ ...BASE, sessionId: 's1', kind: 'claude', title: 'Feed fix' }],
      tldr: { s1: { text: 'Working on the fold', updatedAt: '2026-09-17T10:00:00Z', revision: 1 } },
    })
    render(<FleetHome feed={feed} connection="open" onSelect={onSelect} onUnpair={() => {}} />)

    // Tap (press + quick release) navigates.
    fireEvent.pointerDown(screen.getByText('Feed fix'), { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(screen.getByText('Feed fix'), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('Feed fix'))
    expect(onSelect).toHaveBeenCalledWith('s1')

    // Hold (350ms) opens the peek, and the release-tail click is swallowed.
    // act() around the timer advance: the long-press timer fires a state
    // update outside React's event batching, so without it the overlay
    // never paints inside the test.
    fireEvent.pointerDown(screen.getByText('Feed fix'), { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByRole('note').textContent).toContain('Working on the fold')
    fireEvent.pointerUp(screen.getByText('Feed fix'), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('Feed fix'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('shows a usage chip only when a provider row is at warning or critical', () => {
    const critical: UsageSnapshot = {
      fetchedAt: '2026-09-17T10:00:00Z',
      cache: { hit: true, ttlMs: 30_000 },
      providers: [
        {
          provider: 'claude',
          status: 'ok',
          sourceLabel: 'Claude',
          plan: null,
          rows: [{ id: 'r1', label: 'Claude usage', percent: 90, severity: 'critical', resetsAt: null, active: true, detail: null, scope: 'all-models' }],
          spend: null,
          extraUsage: null,
          credits: null,
        },
      ],
    }
    const feed = fakeFeed({ summaries: [], usage: critical })
    const first = render(
      <FleetHome feed={feed} connection="open" onSelect={() => {}} onUnpair={() => {}} />,
    )
    expect(screen.getByText('usage critical')).toBeTruthy()
    first.unmount()

    // Fresh mount without a snapshot: no chip. (The snapshot is mount-time
    // state + onUsage pushes; a rerender with a different feed object would
    // keep the stale state by design.)
    render(
      <FleetHome
        feed={fakeFeed({ summaries: [], usage: null })}
        connection="open"
        onSelect={() => {}}
        onUnpair={() => {}}
      />,
    )
    expect(screen.queryByText(/usage/)).toBeNull()
  })
})
