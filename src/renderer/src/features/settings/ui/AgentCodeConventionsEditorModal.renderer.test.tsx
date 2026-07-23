import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeConventionsSnapshot } from '@shared/types/agentCodeConventions.js'
import { AgentCodeConventionsEditorModal } from './AgentCodeConventionsEditorModal'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function snapshot(): AgentCodeConventionsSnapshot {
  return {
    revision: 4,
    enabled: false,
    markdown: '',
    updatedAt: null,
    health: 'disabled',
    warnings: [],
    unsupportedProviders: [],
    targets: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentCodeConventionsEditorModal', () => {
  it('saves one revisioned draft and refreshes its base revision from main', async () => {
    const saved: AgentCodeConventionsSnapshot = {
      ...snapshot(),
      revision: 5,
      enabled: true,
      markdown: '# Rules',
      health: 'active',
    }
    const save = vi.fn().mockResolvedValue({ ok: true, snapshot: saved })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveAgentCodeConventions: save },
    })
    const onSnapshot = vi.fn()

    render(
      <AgentCodeConventionsEditorModal
        open
        snapshot={snapshot()}
        onOpenChange={vi.fn()}
        onSnapshot={onSnapshot}
      />,
    )
    fireEvent.change(screen.getByLabelText('Convention rules'), { target: { value: '# Rules' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable conventions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & Enable' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      enabled: true,
      markdown: '# Rules',
      overwriteTargets: [],
    }))
    expect(onSnapshot).toHaveBeenCalledWith(saved)
    expect(await screen.findByText(/Agent Code will reconcile before starting new agents/)).toBeTruthy()
  })

  it('uses main for the exact generated preview', async () => {
    const preview = vi.fn().mockResolvedValue({
      ok: true,
      renderedSkill: '---\nname: agent-code-conventions\n---\n',
      warnings: ['Keep conventions concise so they use less model context when activated.'],
      counts: { lines: 1, characters: 7, bytes: 7 },
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { previewAgentCodeConventions: preview },
    })

    render(
      <AgentCodeConventionsEditorModal
        open
        snapshot={{ ...snapshot(), markdown: '# Rules' }}
        onOpenChange={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview generated skill' }))
    expect(await screen.findByText(/name: agent-code-conventions/)).toBeTruthy()
    expect(preview).toHaveBeenCalledWith('# Rules')
    fireEvent.click(screen.getByRole('button', { name: 'Back to editor' }))
    expect(screen.getByText(/Keep conventions concise/)).toBeTruthy()
  })

  it('preserves a stale draft until the user explicitly reloads the latest revision', async () => {
    const latest: AgentCodeConventionsSnapshot = {
      ...snapshot(),
      revision: 5,
      markdown: '# Saved elsewhere',
    }
    const save = vi.fn().mockResolvedValue({
      ok: false,
      code: 'revision-conflict',
      snapshot: latest,
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveAgentCodeConventions: save },
    })

    render(
      <AgentCodeConventionsEditorModal
        open
        snapshot={snapshot()}
        onOpenChange={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    )
    const editor = screen.getByLabelText('Convention rules')
    fireEvent.change(editor, { target: { value: '# Unsaved draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/newer saved version/)).toBeTruthy()
    expect(editor).toHaveValue('# Unsaved draft')
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    expect(editor).toHaveValue('# Saved elsewhere')
  })
})
