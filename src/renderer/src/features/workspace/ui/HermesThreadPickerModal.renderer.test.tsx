import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { summarizeLanes } from 'hermes-headless'
import { recordingFor } from 'hermes-headless/testing/corpus'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SESSION_START_FAILED_MESSAGE } from '@shared/types/session'

import { HermesThreadPickerModal } from './HermesThreadPickerModal'

// Review of #1521 (Codex, medium): the picker closes before the swap runs, so
// a swap that failed (server unreachable, a refused commit) used to be an
// unhandled rejection or silence, and the pane quietly stayed on the old
// thread. Lanes are the REAL recorded T8 listing (hermes-headless corpus,
// v0.22.0); the rejection and the refused commit are the two outcomes
// replaceSession has besides success.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

const listing = recordingFor('T8', 'v0.22.0')
  .filter((entry) => entry.dir === 'in' && entry.kind === 'http' && /\/api\/sessions\?/.test(String(entry.frame.url)) && entry.frame.status === 200)
  .at(-1)!.frame.body as { sessions: Parameters<typeof summarizeLanes>[0] }
const lanes = summarizeLanes(listing.sessions).map(({ headId: _headId, ...lane }) => lane)

function mount(replaceSession: Workspace['replaceSession']) {
  Object.defineProperty(window, 'api', { configurable: true, value: { hermesListLanes: vi.fn(async () => ({ ok: true, lanes })) } })
  const showPaneToast = vi.fn()
  const workspace = {
    state: { sessions: { pane: { kind: 'hermes', cwd: '/recorded/project', remoteConnectionId: 'vps', hermesLaneKey: 'agent:main:telegram:dm:111' } } },
    replaceSession,
    showPaneToast,
  } as unknown as Workspace
  const onClose = vi.fn()
  render(<HermesThreadPickerModal open sessionId="pane" workspace={workspace} onClose={onClose} />)
  return { showPaneToast, onClose }
}

async function pickTopic() {
  const topic = await screen.findByText('Direct chat topic 7 · Tester')
  await act(async () => { fireEvent.click(topic) })
}

it('says on the pane when the thread swap fails, instead of an unhandled rejection', async () => {
  const replaceSession = vi.fn(async () => { throw new Error('ECONNREFUSED token=secret-value') })
  const { showPaneToast, onClose } = mount(replaceSession)
  await pickTopic()
  await waitFor(() => expect(showPaneToast).toHaveBeenCalledWith('pane', `Could not switch this pane to Direct chat topic 7 · Tester: ${SESSION_START_FAILED_MESSAGE}`))
  expect(onClose).toHaveBeenCalled()
  expect(replaceSession).toHaveBeenCalledWith('/recorded/project', expect.objectContaining({ targetSessionId: 'pane', hermesLaneKey: 'agent:main:telegram:dm:111:7', newConversation: true }))
  // Never the rejection's own text: spawn errors can carry secrets.
  expect(String(showPaneToast.mock.calls[0]?.[1])).not.toContain('secret-value')
})

it('says on the pane when the swap was not committed', async () => {
  const { showPaneToast } = mount(vi.fn(async () => undefined))
  await pickTopic()
  await waitFor(() => expect(showPaneToast).toHaveBeenCalledWith('pane', 'Could not switch this pane to Direct chat topic 7 · Tester.'))
})

it('swaps once when the row is chosen twice before the picker unmounts', async () => {
  // The surface unmounts the dialog on close; here it stays mounted, which is
  // exactly the window a second click or Enter lands in.
  const replaceSession = vi.fn(async () => 'successor')
  mount(replaceSession)
  const topic = await screen.findByText('Direct chat topic 7 · Tester')
  await act(async () => { fireEvent.click(topic); fireEvent.click(topic) })
  expect(replaceSession).toHaveBeenCalledTimes(1)
})
