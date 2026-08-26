import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTitlePrompt } from '@renderer/features/workspace/ui/AgentTitlePrompt'
import { AGENT_TITLE_MAX_LENGTH } from '@renderer/workspace/agentTitle'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/DispatchAgentList'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import type { Entry } from '@shared/types/transcript'

describe('Agent title prompt', () => {
  it('prefills and saves the edited title', () => {
    const onSave = vi.fn()
    render(
      <AgentTitlePrompt
        open
        initialTitle="Queue audit"
        description="/work/project"
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    )

    const input = screen.getByLabelText('Title')
    expect(input).toHaveValue('Queue audit')
    fireEvent.change(input, { target: { value: 'Queue ownership race' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('Queue ownership race')
  })

  it('uses an explicit clear action rather than persisting placeholder text', () => {
    const onSave = vi.fn()
    render(
      <AgentTitlePrompt
        open
        initialTitle="Review"
        description="/work/project"
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear title' }))
    expect(onSave).toHaveBeenCalledWith('')
  })

  it('applies the 120-character input limit by Unicode code point', () => {
    render(
      <AgentTitlePrompt
        open
        initialTitle=""
        description="/work/project"
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Title')
    fireEvent.change(input, {
      target: { value: `${'🙂'.repeat(AGENT_TITLE_MAX_LENGTH)}extra` },
    })
    expect(input).toHaveValue('🙂'.repeat(AGENT_TITLE_MAX_LENGTH))
  })
})

describe('Agent title presentation', () => {
  it('renders the title as the second row immediately below pane identity', () => {
    const { container } = render(
      <PaneHeader
        sessionId="agent"
        paneLabel="A3"
        agentTitle="Investigate queue race"
        projectDir="/work/project"
        statusMode
        isSessionLive
      />,
    )

    const identity = container.querySelector('[data-pane-header-row="true"]')
    const title = container.querySelector('[data-agent-title-header="true"]')
    expect(title).toHaveTextContent('Investigate queue race')
    expect(identity?.nextElementSibling).toBe(title)
  })

  it('does not reserve a second row for an untitled agent', () => {
    const { container } = render(
      <PaneHeader
        sessionId="agent"
        paneLabel="A3"
        projectDir="/work/project"
        statusMode
        isSessionLive={false}
      />,
    )

    expect(container.querySelector('[data-agent-title-header="true"]')).toBeNull()
  })

  it('keeps explicit titles ahead of the automatic latest-prompt fallback', () => {
    const entries = [{
      type: 'user',
      uuid: 'prompt',
      parentUuid: null,
      message: { role: 'user', content: 'Latest user prompt' },
    }] as Entry[]

    expect(dispatchRowTitle({
      kind: 'codex',
      agentTitle: 'Queue audit',
      title: 'project',
    }, entries)).toBe('Queue audit')
    expect(dispatchRowTitle({ kind: 'codex', title: 'project' }, entries)).toBe(
      'Latest user prompt',
    )
  })
})
