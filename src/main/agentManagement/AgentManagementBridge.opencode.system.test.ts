import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectionDatabase,
  listDurableFixtures,
  loadDurableFixture,
} from 'opencode-terminal-headless/testing/index'
import type { ManagedAgentRendererDescriptor } from '@mcp/shared/agentManagementTypes.js'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const sentRendererRequests: unknown[] = []
const resolveProviderTranscriptPath = vi.fn(async () => '/tmp/provider-agent.jsonl')

// See the note in OrchestrationBridge.test.ts: routing is stubbed to one
// always-resolvable window so these tests can be about the bridge's own
// serialization and inventory behavior.
const sessionWindowOwner = vi.fn((_sessionId: string): string | null => 'test-window')

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: unknown) => {
    sentRendererRequests.push(request)
  },
  windowForSession: (sessionId: string) => sessionWindowOwner(sessionId),
}))

vi.mock('@main/providerSwitch/shared.js', () => ({
  resolveProviderTranscriptPath,
  findCodexRolloutPathsBySessionIds: vi.fn(async () => new Map()),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

// OpenCode sessions are located in a real database built from a recorded
// session, so the published locator and its date come from OpenCode's own
// rows. The path is set by the test that needs it.
const opencodeFixture = vi.hoisted(() => ({ file: '' }))
vi.mock('@providers/opencode/runtime/opencodeDatabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/opencode/runtime/opencodeDatabase.js')>()
  const database = actual.createOpencodeDatabase({ resolveDbPath: async () => opencodeFixture.file })
  return {
    ...actual,
    opencodeDatabase: database,
    readOpencodeSessionInfo: (sessionID: string) => actual.readOpencodeSessionInfo(sessionID, database),
  }
})

const { AgentManagementBridge } = await import('@main/agentManagement/AgentManagementBridge.js')
const { stat } = await import('node:fs/promises')
const { opencodeDatabase } = await import('@providers/opencode/runtime/opencodeDatabase.js')

function managerFixture() {
  return {
    getBackendSnapshot: vi.fn((sessionId: string) => sessionId === 'agent-1'
      ? { lifecycle: 'live' }
      : null),
    getLastActivityAt: vi.fn(() => 8_000),
    resolveTranscriptFile: vi.fn(async (_sessionId: string): Promise<string | null> => null),
    getTranscriptFile: vi.fn(() => null),
  }
}

function rendererDescriptor(): ManagedAgentRendererDescriptor {
  return {
    agent: {
      sessionId: 'agent-1',
      kind: 'claude' as const,
      cwd: '/tmp/project',
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      placement: 'dispatch' as const,
      backendState: 'hibernated' as const,
      activityState: 'completed' as const,
      transcript: { path: null, availability: 'unavailable' as const },
      processActive: false,
      awaitingAssistant: false,
      requiresUserAction: false,
      isCaller: false,
    },
    providerSessionId: 'provider-agent-1',
    runtimeActivityAt: 7_000,
  }
}

describe('AgentManagementBridge OpenCode inventory', () => {
  beforeEach(() => { sentRendererRequests.length = 0; resolveProviderTranscriptPath.mockClear() })
  it('publishes OpenCode agents by their opencode:// locator, dated by the session row, and never stats it', async () => {
    const recorded = loadDurableFixture(listDurableFixtures().find(name => name.includes('ses_47fca639'))!)
    const dir = mkdtempSync(join(tmpdir(), 'agent-management-opencode-'))
    opencodeFixture.file = join(dir, 'opencode.db')
    try {
      createProjectionDatabase(recorded, opencodeFixture.file)
      const manager = managerFixture()
      const live = `opencode://session/${recorded.meta.sessionID}`
      // A running OpenCode agent already published its locator on its
      // committed entries; a parked one is known only by its session id.
      manager.resolveTranscriptFile.mockImplementation(async sessionId => (sessionId === 'oc-live' ? live : null))
      const bridge = new AgentManagementBridge(manager as never)
      const pending = bridge.listAgents({ callerSessionId: 'caller' })
      const request = sentRendererRequests[0] as { requestId: string }
      const opencodeAgent = (sessionId: string, providerSessionId: string): ManagedAgentRendererDescriptor => {
        const descriptor = rendererDescriptor()
        return {
          ...descriptor,
          agent: { ...descriptor.agent, sessionId, kind: 'opencode' },
          providerSessionId,
        }
      }
      bridge.resolve({
        requestId: request.requestId,
        ok: true,
        type: 'list-agents',
        observedAt: 10_000,
        project: { tabId: 'tab-1', title: 'Project', index: 0 },
        agents: [
          opencodeAgent('oc-live', recorded.meta.sessionID),
          opencodeAgent('oc-parked', recorded.meta.sessionID),
          opencodeAgent('oc-deleted', 'ses_deleted_from_opencode'),
        ],
      })

      const available = { path: live, availability: 'available', lastModifiedAt: Number(recorded.session.time_updated) }
      await expect(pending).resolves.toMatchObject({
        agents: [
          { sessionId: 'oc-live', transcript: available },
          { sessionId: 'oc-parked', transcript: available },
          // A locator a reader could not open is not published.
          { sessionId: 'oc-deleted', transcript: { path: null, availability: 'unavailable' } },
        ],
      })
      // OpenCode has no file to resolve or stat.
      expect(resolveProviderTranscriptPath).not.toHaveBeenCalled()
      expect(vi.mocked(stat)).not.toHaveBeenCalledWith(expect.stringMatching(/^opencode:/))
    } finally {
      opencodeDatabase.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })

})
