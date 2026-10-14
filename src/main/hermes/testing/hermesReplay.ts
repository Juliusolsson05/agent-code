// Test-only: play a RECORDED Hermes WebSocket session (hermes-headless
// research/corpus) to the client, for the `hermes` MCP domain's tests
// (#1512). See agentBridge.test.ts for what is recorded and the two calls
// today's client makes that the recording does not hold.
import { FakeSocket } from 'hermes-headless/testing/fakeSocket'
import { latestRecording, type CorpusEntry } from 'hermes-headless/testing/corpus'

import type { HermesConnectionInfo } from '@shared/hermes/types.js'

import { HermesAgentBridge, type HermesBridgeConnections } from '../agentBridge.js'

type Frame = Record<string, unknown>

/** The recording split into its WebSocket connections, each a list of steps. */
export function connections(entries: CorpusEntry[]): CorpusEntry[][] {
  const out: CorpusEntry[][] = []
  for (const entry of entries) {
    if (entry.kind === 'ws-open') out.push([])
    else if (entry.kind === 'ws' && out.length > 0) out[out.length - 1]!.push(entry)
  }
  return out.filter((steps) => steps.length > 0)
}

/** The stored conversation as the server returned it on the recorder's reconnect. */
export function storedHistory(entries: CorpusEntry[]): Frame[] {
  for (const step of connections(entries).slice(1).flat()) {
    const messages = (step.frame.result as { messages?: Frame[] } | undefined)?.messages
    if (step.dir === 'in' && Array.isArray(messages) && messages.length > 0) return messages
  }
  return []
}

/**
 * Play one recorded connection on `socket`. Returns when the recording ends
 * (or `stopAfter` matches a pushed frame), leaving the socket open.
 */
export async function replay(socket: FakeSocket, steps: CorpusEntry[], history: Frame[]): Promise<void> {
  // The client attaches its listeners after dial() resolves; a frame pushed
  // before that is lost, as a real server's would never be.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const answered = new Set<unknown>()
  let alive = true
  // Two calls today's client makes that the recording's (older) client did
  // not: the post-turn history fetch (answered with the stored conversation,
  // see header) and the event-ring read right after attaching. The ring is
  // answered empty, exactly as hermes-headless's own system tests do: the
  // conversation was attached a moment ago, and the recorded events that
  // follow are pushed live below.
  const extra: Record<string, () => unknown> = {
    'session.history': () => ({ messages: history }),
    'session.events.since': () => ({ events: [], latest_seq: 0, truncated: false, count: 0 }),
  }
  for (const [method, answer] of Object.entries(extra)) {
    void (async () => {
      while (alive) {
        const call = await socket.nextSent((frame) => frame.method === method && !answered.has(frame.id))
        if (!alive) return
        answered.add(call.id)
        socket.push({ jsonrpc: '2.0', id: call.id, result: answer() })
      }
    })()
  }
  let pending: unknown = null
  for (const step of steps) {
    if (socket.readyState !== 1) break
    if (step.dir === 'out') {
      const method = step.frame.method
      const call = await Promise.race([
        socket.nextSent((frame) => frame.method === method && !answered.has(frame.id)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ])
      // The client chose not to make this recorded call (the recorder's own
      // probes); skip it rather than stall.
      if (!call) continue
      answered.add(call.id)
      pending = call.id
    } else if ('result' in step.frame || 'error' in step.frame) {
      if (pending === null) continue
      socket.push({ ...step.frame, id: pending })
      pending = null
    } else {
      socket.push(step.frame)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  alive = false
}

export const CONNECTION: HermesConnectionInfo = {
  id: 'conn-1',
  name: 'VPS',
  baseUrl: 'https://hermes.example',
  createdAt: 0,
  state: 'ready',
  identity: null,
  backend: null,
  lastError: null,
}

export function bridgeOn(scenario: string, stateDir: string, connectionIndex = 0, options: { everyDialReplays?: 'same' } = {}) {
  const entries = latestRecording(scenario, { release: 'v0.22.0' })
  const recorded = connections(entries)
  const history = storedHistory(entries)
  const knownIds = new Set(recorded.flat().map((step) => (step.frame.result as { stored_session_id?: unknown } | undefined)?.stored_session_id).filter((id): id is string => typeof id === 'string'))
  const dials: FakeSocket[] = []
  const fake: HermesBridgeConnections = {
    list: () => [CONNECTION],
    dialFor: () => async () => {
      const socket = new FakeSocket()
      dials.push(socket)
      // Default: the Nth dial replays the recording's Nth connection. `same`:
      // every dial replays the same one (independent callers, e.g. two agents
      // whose first sends race).
      void replay(socket, recorded[options.everyDialReplays === 'same' ? connectionIndex : Math.min(connectionIndex + dials.length - 1, recorded.length - 1)]!, history)
      return socket
    },
    // REST as the recorded server would answer it: the recording's own
    // stored conversations exist, anything else is Hermes' 404 (`_NOT_FOUND`,
    // web_routers/sessions.py latest-descendant).
    restFor: () => ({
      latestDescendant: async (id: string) => {
        if (!knownIds.has(id)) throw Object.assign(new Error('Not found'), { status: 404 })
        return { requested_session_id: id, session_id: id, path: [id], changed: false }
      },
    }) as unknown as ReturnType<HermesBridgeConnections['restFor']>,
    lookupLaneKey: async () => null,
  }
  const bridge = new HermesAgentBridge({ connections: fake, stateDir, headlessOptions: { heartbeatIntervalMs: 600_000 } })
  return { bridge, dials, knownIds }
}

