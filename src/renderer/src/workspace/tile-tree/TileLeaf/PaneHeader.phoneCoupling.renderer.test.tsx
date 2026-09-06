import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { GridRelatedAgentTab } from '@renderer/workspace/gridRelatedAgents'

import { PaneHeader } from './PaneHeader'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

const related: GridRelatedAgentTab[] = [{
  sessionId: 'related-session',
  relation: 'orchestration',
  label: 'assistant',
  title: 'assistant',
  kind: 'claude',
  placement: 'grid',
}]

const running = (): ReturnType<typeof emptyRuntime> =>
  ({ ...emptyRuntime(), sessionStatus: 'running' })

describe('PaneHeader related-status store coupling', () => {
  it('renders with no related chips without touching workspaceRuntimes (today\'s phone call shape)', () => {
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
        relatedAgentTabs={[]}
      />,
    )
    // The phone (src/remote-client) shares this component but stubs the app
    // store to `{ settings }` only and always passes an empty chip list. The
    // related row must not mount — and this must never throw on the missing
    // `workspaceRuntimes` key.
    expect(container.querySelector('button')).toBeNull()
  })

  it('survives a store with no workspaceRuntimes key when chips are non-empty (phone stub shape)', () => {
    // The real renderer store always has the key, so reproducing the phone
    // stub requires temporarily removing it. This pins the fallback contract:
    // a keyless store must degrade to the `runtimes` prop instead of throwing.
    useAppStore.setState({ workspaceRuntimes: undefined as never })
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
        relatedAgentTabs={related}
        runtimes={{ 'related-session': running() }}
        onSelectRelatedSession={() => undefined}
      />,
    )
    const chip = container.querySelector('button')
    expect(chip).not.toBeNull()
    expect(chip!.querySelector('.bg-accent')).not.toBeNull()
  })

  it('derives related status from the store when the key exists (desktop path)', () => {
    useAppStore.setState({ workspaceRuntimes: { 'related-session': running() } })
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
        relatedAgentTabs={related}
      />,
    )
    const chip = container.querySelector('button')
    expect(chip).not.toBeNull()
    expect(chip!.querySelector('.bg-accent')).not.toBeNull()
  })
})