import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLiveFixture, referenceActiveBranch, toJsonl } from 'pi-terminal-headless/testing/index'

import { loadPiHistoryChunk } from '@providers/pi/runtime/piHistory'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import { extractLatestUserPrompts } from '@renderer/features/workspace/lib/latestUserPrompts'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import { commandAllowedByRenderedViewPolicy, getEffectiveAgentSurfaceForSession, type RenderedViewPolicy } from '@renderer/workspace/agentDisplayMode'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import { sessionHasTranscript } from '@renderer/workspace/transcriptAvailability'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { makeWorkspaceRefsForTest } from './testing/workspaceRefsForTest'

// A Pi pane after a reload or restart: its conversation comes back through the
// REAL Pi history source (what main's history loader delegates to, since Pi
// registers loadHistoryChunk) and the real renderer loader, from a recorded
// session file with an abandoned /tree branch. The pane stays pi's TUI; the
// history is for everything that reads runtime.entries.
//
// The pane is restored the way the conversation catalog, a split chord or a
// provider switch restores it — kind only, NO providerRuntime — because that
// is the shape the terminal-only resolution exists for.

const SESSION_ID = 'pi-pane' as SessionId
const dirs: string[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { gitWorktrees: vi.fn(async () => ({ ok: false })) } })
})
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function restoredPane(fileRows: ReturnType<typeof loadLiveFixture>['files'][string]) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pane-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, toJsonl(fileRows))
  const loadInitialHistory = vi.fn((request: { cwd: string; providerSessionId: string; limit: number }) =>
    loadPiHistoryChunk({ cwd: request.cwd, providerSessionId: request.providerSessionId, limit: request.limit }, { resolveFile: async () => file }))
  Object.defineProperty(window, 'api', { configurable: true, value: { ...window.api, loadInitialHistory, loadOlderHistory: vi.fn() } })

  const meta: SessionMeta = { cwd: '/sandbox/project', kind: 'pi', providerSessionId: String(fileRows[0]!.id), providerSessionIdSource: 'jsonl-entry' }
  const workspace: WorkspaceState = {
    tabs: [{ id: 'project', title: 'project' }],
    activeTabId: 'project',
    stage: freshStage(),
    sessions: { [SESSION_ID]: { ...meta, projectId: 'project', joinedAt: 0 } },
    pinnedSessionIds: [],
  }
  let runtimes: Record<SessionId, SessionRuntime> = { [SESSION_ID]: { ...emptyRuntime(), ...seedResumedRuntimeFields(undefined, meta) } }
  const refs = makeWorkspaceRefsForTest(workspace)
  refs.latestRuntimesRef.current = runtimes
  const setRuntimes: WorkspaceSetRuntimes = next => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  return { meta, refs, setRuntimes, loadInitialHistory, runtime: () => runtimes[SESSION_ID]! }
}

describe('a Pi pane after a reload', () => {
  it('loads the branch pi would resume, never an abandoned turn, and keeps the TUI surface', async () => {
    const fixture = loadLiveFixture('tree')
    const rows = Object.values(fixture.files)[0]!
    const pane = restoredPane(rows)
    await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })

    expect(pane.loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'pi', providerSessionId: pane.meta.providerSessionId }))
    const runtime = pane.runtime()
    expect(runtime.transcriptStatus).toBe('ready')

    // Expectations from the independent reference walk over the recording.
    const branch = referenceActiveBranch(rows)
    const text = (row: (typeof rows)[number]) => ((row.message as { content: Array<{ type: string; text?: string }> }).content).filter(b => b.type === 'text').map(b => b.text).join('')
    const branchUserTexts = branch.filter(row => row.type === 'message' && (row.message as { role: string }).role === 'user').map(text)
    const abandonedUserTexts = rows.filter(row => row.type === 'message' && (row.message as { role: string }).role === 'user' && !branch.some(b => b.id === row.id)).map(text)
    expect(abandonedUserTexts.length).toBeGreaterThan(0)

    // View Prompts reads these; they are exactly the branch's prompts.
    expect(extractLatestUserPrompts(runtime.entries, 'pi').map(prompt => prompt.text)).toEqual(branchUserTexts)
    // Copy Last Response reads the last answer on the branch.
    const lastAssistant = [...branch].reverse().find(row => row.type === 'message' && (row.message as { role: string }).role === 'assistant')!
    expect(extractLastAssistantText(runtime.entries, 'pi')).toBe(text(lastAssistant))

    // The history is for the app, not for display: whatever the global mode,
    // pi's TUI keeps the pane and no feed-only command appears — with no
    // providerRuntime stored at all.
    expect(pane.meta.providerRuntime).toBeUndefined()
    for (const globalMode of ['agent', 'hybrid', 'terminal'] as const) {
      expect(getEffectiveAgentSurfaceForSession({ kind: 'pi', providerRuntime: pane.meta.providerRuntime, globalMode, override: undefined, runtime })).toBe('terminal')
    }
    const feedPolicies: RenderedViewPolicy[] = [{ kind: 'requires-rendered-feed' }, { kind: 'opens-rendered-feed' }, { kind: 'leases-rendered-feed', feature: 'copy-assistant-message' }]
    for (const policy of feedPolicies) {
      expect(commandAllowedByRenderedViewPolicy({ policy, kind: 'pi', mode: 'agent', runtime })).toBe(false)
    }
    // Reader Mode / View Prompts / Copy Last Response are offered. (That the
    // Rewind COMMAND stays hidden on this pane is pinned by the session
    // commands' capability-gate test.)
    expect(sessionHasTranscript(pane.meta)).toBe(true)
    expect(getProviderFeatures('pi').promptHistoryExtraction).toBe(true)
  })

  it('a fresh session pi has not written yet loads as an empty, ready conversation — not an error', async () => {
    const fixture = loadLiveFixture('plain')
    const pane = restoredPane(Object.values(fixture.files)[0]!)
    ;(window.api as { loadInitialHistory: unknown }).loadInitialHistory = vi.fn((request: { cwd: string; providerSessionId: string; limit: number }) =>
      loadPiHistoryChunk({ ...request }, { resolveFile: async () => null }))
    await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
    expect(pane.runtime().transcriptStatus).toBe('ready')
    expect(pane.runtime().entries).toEqual([])
    expect(pane.runtime().transcriptError ?? null).toBeNull()
  })
})
