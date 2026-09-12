import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ViewPromptsModal } from './ViewPromptsModal'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

// The catalog returns prompts newest first; the modal once reversed them
// again and showed the oldest prompt at the top (bf8069c6). The numbering
// counts down from the total so the newest row reads as the highest prompt.
describe('ViewPromptsModal', () => {
  it('lists the transcript prompts newest first with relative times and a whole count', async () => {
    const listConversationPrompts = vi.fn(async () => [
      { text: 'newest prompt', timestamp: Date.now() - 2 * 3600_000 },
      { text: 'middle prompt', timestamp: Date.now() - 26 * 3600_000 },
      { text: 'oldest prompt', timestamp: null },
    ])
    Object.defineProperty(window, 'api', { configurable: true, value: { listConversationPrompts } })
    const workspace = {
      state: { sessions: { s: { kind: 'claude', cwd: '/repo/project', providerSessionId: 'native-1' } } },
      getRuntime: () => ({ entries: [], hasOlderHistory: false, loadingOlderHistory: false }),
    } as unknown as Workspace
    render(<ViewPromptsModal open sessionId="s" workspace={workspace} onClose={vi.fn()} />)
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('newest prompt')
    expect(items[0]).toHaveTextContent('#3')
    expect(items[0]).toHaveTextContent('2h ago')
    expect(items[2]).toHaveTextContent('oldest prompt')
    expect(items[2]).toHaveTextContent('unknown time')
    expect(screen.getByText('3 prompts')).toBeInTheDocument()
    expect(listConversationPrompts).toHaveBeenCalledWith({ provider: 'claude', nativeId: 'native-1', cwd: '/repo/project' })
  })
})
