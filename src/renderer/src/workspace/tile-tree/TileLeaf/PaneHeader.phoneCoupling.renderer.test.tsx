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

  it('renders no agent name on a store with no workspace keys (phone stub shape)', () => {
    // src/remote-client aliases @renderer/app-state/hooks to a stub whose
    // state is `{ settings }` (vite.config.ts). tsconfig.web.json type-checks
    // that directory against the REAL hooks module, so a selector reading
    // state.workspaceState compiles and then throws on a device. Reproducing
    // the stub shape here is the only place that can catch it.
    useAppStore.setState({
      workspaceState: undefined as never,
      workspaceAgentNames: undefined as never,
    })
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
        relatedAgentTabs={[]}
      />,
    )
    // Degrade, never throw — and with no workspace there is no name to show,
    // so the title row stays absent exactly as it is on the phone today.
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toBeNull()
  })
})