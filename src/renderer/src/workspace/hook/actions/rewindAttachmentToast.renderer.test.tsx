import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { makeRefs, sessionActionsWithSpawn } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { AgentProviderKind } from '@shared/types/providerKind'

// #1075. Main has produced a loss report for every attachment on a rewound
// prompt since #1073, and the Rewind PICKER uses it — a turn with an
// attachment is labelled `[Image prompt]` or `[Attachment unavailable: …]`
// instead of vanishing from the list. Nothing used it AFTER the rewind.
//
// So the user picked a row labelled `[Image prompt]`, the rewind succeeded,
// and the composer was EMPTY with no explanation — because Codex, OpenCode and
// Grok declare `supportsImageAttachments: false` and the restored image is
// dropped on the way in. These drive the real `rewindSessionToPrompt` and
// assert what the pane is told.

const original = useAppStore.getState()
const originalApi = window.api

afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  window.api = originalApi
})

function setup(kind: AgentProviderKind, promptAttachments: Array<Record<string, unknown>>) {
  useAppStore.setState({
    workspaceState: {
      ...original.workspaceState,
      activeTabId: 'project',
      tabs: [{ id: 'project', title: 'Project' }],
      sessions: {
        source: { kind, cwd: '/source', providerSessionId: 'native-source', projectId: 'project', joinedAt: 0 },
      },
    },
    workspaceRuntimes: { source: { ...emptyRuntime() } },
  } as never)
  const refs = makeRefs(useAppStore.getState().workspaceState)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const replaceSession = vi.fn().mockImplementation(async () => {
    useAppStore.getState().setWorkspaceRuntimes(previous => ({
      ...previous,
      replacement: { ...emptyRuntime() },
    }))
    refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
    return 'replacement'
  })
  const showPaneToast = vi.fn()
  const rewindToPrompt = vi.fn().mockResolvedValue({
    provider: kind,
    newProviderSessionId: 'rewound-native',
    newFilePath: '/recorded/rewound.jsonl',
    promptText: 'look at this',
    promptMode: 'prompt',
    promptTimestamp: '2026-09-20T10:00:00.000Z',
    promptImages: promptAttachments
      .filter(attachment => attachment.status === 'restored')
      .map(() => ({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })),
    promptAttachments,
  })
  window.api = { ...originalApi, rewindToPrompt }
  const mounted = renderHook(() => useProviderActions(
    refs,
    useAppStore.getState().setWorkspaceRuntimes,
    showPaneToast,
    sessionActionsWithSpawn(vi.fn(), { replaceSession, splitFocused: vi.fn() } as never),
  ))
  return { mounted, showPaneToast }
}

const anchorFor = (provider: AgentProviderKind) => ({
  provider,
  promptIndex: 0,
  promptTimestamp: '2026-09-20T10:00:00.000Z',
} as never)

async function rewind(kind: AgentProviderKind, promptAttachments: Array<Record<string, unknown>>) {
  const { mounted, showPaneToast } = setup(kind, promptAttachments)
  await act(async () => {
    await mounted.result.current.rewindSessionToPrompt('source' as never, anchorFor(kind))
  })
  const toasts = showPaneToast.mock.calls.map(([, message]) => String(message))
  return toasts.find(message => message.startsWith('Rewound to prompt')) ?? ''
}

describe('a rewind says what it could not bring back (#1075)', () => {
  it('tells the user when a restored image cannot go in this provider’s composer', async () => {
    // The issue's headline case. The rewind WORKED and the attachment was
    // restored perfectly; it is the composer that cannot carry it, and before
    // this the user got an empty composer and the ordinary success toast.
    const message = await rewind('codex', [{ status: 'restored', mediaType: 'image/png', name: 'shot.png' }])

    expect(message).toContain('1 attachment')
    expect(message).toMatch(/cannot carry images/)
    // The undo affordance is still advertised: the loss note is added to that
    // sentence, not substituted for it.
    expect(message).toContain('Undo Rewind')
  })

  it('says the ordinary thing when the composer really did get everything', async () => {
    // The control. "Always warn" would satisfy the case above and put a
    // warning on every Claude image rewind that worked perfectly.
    const message = await rewind('claude', [{ status: 'restored', mediaType: 'image/png', name: 'shot.png' }])

    expect(message).toBe('Rewound to prompt - Undo Rewind available until next submit')
  })

  it('says the ordinary thing when there were no attachments at all', async () => {
    const message = await rewind('codex', [])

    expect(message).toBe('Rewound to prompt - Undo Rewind available until next submit')
  })

  it('names what was unavailable even on a provider that carries images', async () => {
    const message = await rewind('claude', [
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: 'design.png' },
    ])

    expect(message).toContain('design.png')
    expect(message).toMatch(/recorded a reference/)
  })
})
