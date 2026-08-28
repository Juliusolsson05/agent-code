import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import type { Entry } from '@shared/types/transcript'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ReaderView } from './ReaderView'

function assistantEntry(uuid: string, text: string): Entry {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: text },
  } as Entry
}

function makeReaderWorkspace(): Workspace {
  const runtime = {
    ...emptyRuntime(),
    entries: [
      assistantEntry('older-message', 'Older answer'),
      assistantEntry('newer-message', 'Newer answer'),
    ],
  }
  const tab = {
    id: 'tab-1',
    title: 'Project',
    focusedSessionId: 'session-1',
    root: { type: 'leaf' as const, sessionId: 'session-1' },
  }
  return {
    state: {
      activeTabId: tab.id,
      tabs: [tab],
      sessions: {
        'session-1': { cwd: '/project', title: 'Agent', kind: 'claude' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      gridRelatedSelections: {},
      dispatchMode: null,
    },
    activeTab: tab,
    dispatchMode: null,
    readerMode: { tabId: tab.id, focusedSessionId: 'session-1' },
    getRuntime: () => runtime,
    setReaderModeSession: vi.fn(),
  } as unknown as Workspace
}

function pressOptionArrow(key: 'ArrowUp' | 'ArrowDown'): void {
  fireEvent.keyDown(document, { altKey: true, code: key, key })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('Reader history keyboard ownership', () => {
  it('keeps Option+Arrow history navigation inside Reader', () => {
    render(<ReaderView workspace={makeReaderWorkspace()} />)

    expect(screen.getByText('Newer answer')).toBeTruthy()
    pressOptionArrow('ArrowUp')
    expect(screen.getByText('Older answer')).toBeTruthy()
    pressOptionArrow('ArrowDown')
    expect(screen.getByText('Newer answer')).toBeTruthy()
  })

  it('yields history navigation to an app-owned modal above Reader', () => {
    render(<ReaderView workspace={makeReaderWorkspace()} />)
    const modalOwner = document.createElement('div')
    modalOwner.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, 'app')
    document.body.append(modalOwner)

    pressOptionArrow('ArrowUp')

    expect(screen.getByText('Newer answer')).toBeTruthy()
    expect(screen.queryByText('Older answer')).toBeNull()
  })
})
