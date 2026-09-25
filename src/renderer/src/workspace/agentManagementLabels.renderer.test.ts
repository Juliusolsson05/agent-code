import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { globalControlCapabilities } from '@main/control/globalCapabilities'
import { useAppStore } from '@renderer/app-state/store'
import {
  assertManagedTarget,
  listManagedAgentDescriptors,
  ManagedAgentTargetError,
  resolveManagedTarget,
} from '@renderer/workspace/agentManagementMcp'
import type { ManagedAgentNames } from '@renderer/workspace/agentManagementMcp'
import { observeWorkspace } from '@renderer/workspace/control'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceState } from '@renderer/workspace/types'
import { liveWorkspaceFromPersisted } from '@renderer/workspace/workspaceShape'

// #1145: an agent told "send a prompt to b33, the codex agent" could not act,
// because Agent Management listed no labels and targeted only session ids.
//
// The state is the owner's real workspace minutes after that session
// (testing/fixtures/workspace-v2/README.md), through the same persisted→live
// conversion rehydrate uses. It is the shape that matters here: 34 sessions
// over three projects, with terminals and extension views interleaved in
// project B's numbering (they take numbers although Agent Management does not
// list them) and one orchestration parent whose children nest under it.
//
// The ground truth for the label assertions is the recorded tool output, not
// this code: at 02:59:39 UTC `ac_agents_search {provider:"codex"}` returned
// exactly B5, B16 and B28 for these three session ids.
const CALLER = '89937a95-c8fc-4da7-b072-6dd21150454d'
const CODEX = {
  B5: '4d757102-4a13-47c2-9fe0-8a9359cd8323',
  B16: '841200e1-7525-446c-aa5d-1745457f0e79',
  B28: '1f770ae8-8f4e-4e70-aaf9-b1f74ccc4b87',
}
const TERMINAL = 'a15c8aa6-9d69-4907-ad51-71f7fbe5cc01'
const OTHER_PROJECT_AGENT = '9bb36de4-39a0-434a-b0b1-00f017d759bd'
// A session that the recorded file really gave an agentNameId (its own id,
// as the reconciler mints them). The NAME is synthetic: the owner runs with
// Agent names off, so the recording has identities but no allocations.
const NAMED = '575880c6-d447-49b8-aa9b-64705d70c287'

function recordedState(): WorkspaceState {
  const file = JSON.parse(readFileSync(resolve(__dirname, '../../../../testing/fixtures/workspace-v2/2026-09-23-agent-labels.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }
  return liveWorkspaceFromPersisted(file.windows[0]!.workspace)
}

const namesOn = (state: WorkspaceState): ManagedAgentNames => ({
  enabled: true,
  names: { [state.sessions[NAMED]!.agentNameId!]: 'Apollo' },
})

function refusal(run: () => unknown): ManagedAgentTargetError {
  try {
    run()
  } catch (error) {
    if (error instanceof ManagedAgentTargetError) return error
    throw error
  }
  throw new Error('expected a target refusal')
}

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

describe('Agent Management labels on the recorded 2026-09-23 workspace', () => {
  it('lists the label the user sees, matching the recorded ac_agents_search output', () => {
    const { agents } = listManagedAgentDescriptors({ state: recordedState(), runtimes: {}, callerSessionId: CALLER })
    const byId = new Map(agents.map(item => [item.agent.sessionId, item.agent]))
    for (const [label, sessionId] of Object.entries(CODEX)) {
      expect(byId.get(sessionId)?.displayLabel).toBe(label)
    }
    // Every listed agent has a label (none is pinned in this recording), and
    // no two share one — the property that makes a label a usable address.
    const labels = agents.map(item => item.agent.displayLabel)
    expect(labels.every(label => typeof label === 'string' && /^B\d+$/.test(label))).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
    // Terminals are not listed, but they still consume numbers: the list is
    // NOT a contiguous B1..Bn, and deriving labels from list position (the
    // tempting shortcut for a model) would be wrong.
    const numbers = labels.map(label => Number(label!.slice(1)))
    expect(numbers.some((value, index) => index > 0 && value !== numbers[index - 1]! + 1)).toBe(true)
    // Names stay absent while the setting is off.
    expect(agents.some(item => 'agentName' in item.agent)).toBe(false)
  })

  it('resolves a label to the same session ac_agents_search returns for it', async () => {
    const state = recordedState()
    useAppStore.setState({
      workspaceState: state,
      workspaceReaderMode: null,
      workspaceSpotlight: null,
      workspaceRuntimes: {},
    })
    const observed = observeWorkspace(() => ({ restoreStatus: 'complete-restore' }))
    const owner = { kind: 'window' as const, windowId: 'w', generation: 'g' }
    const search = globalControlCapabilities(async () => [{ windowId: 'w', owner, workspace: observed }])
      .find(cap => cap.descriptor.id === 'agents.search')!
    const context = { requestId: 'r', caller: { kind: 'external' as const, id: 't' }, owner: { kind: 'main' as const, generation: 'm' } }

    // Every agent the caller manages, by its own label: the two surfaces must
    // name the same session, or "the agent showing B28" means two things.
    const { agents } = listManagedAgentDescriptors({ state, runtimes: {}, callerSessionId: CALLER })
    for (const { agent } of agents) {
      const searched = await search.execute({ label: agent.displayLabel }, context) as { value: { items: { sessionId: string }[] } }
      expect(searched.value.items.map(item => item.sessionId)).toEqual([agent.sessionId])
      expect(resolveManagedTarget({ state, callerSessionId: CALLER, target: { label: agent.displayLabel! } })).toBe(agent.sessionId)
    }
    // Case and whitespace are the user's, not the resolver's, problem.
    expect(resolveManagedTarget({ state, callerSessionId: CALLER, target: { label: ' b28 ' } })).toBe(CODEX.B28)
  })

  it('refuses the label from the recorded request, and says what the project shows', () => {
    const error = refusal(() => resolveManagedTarget({ state: recordedState(), callerSessionId: CALLER, target: { label: 'b33' } }))
    expect(error.code).toBe('label_not_found')
    expect(error.message).toContain('B33')
    // The model's next move is to ask the user; it needs the candidates in
    // the user's own terms, not raw ids.
    for (const label of Object.keys(CODEX)) expect(error.message).toContain(`${label} (codex`)
    expect(error.message).toContain(', you)')
    // A terminal's label is not an Agent Management target; don't offer it.
    expect(error.message).not.toContain('B3 (')
  })

  it('keeps project authority: a label resolves window-wide, then the project gate refuses', () => {
    const state = recordedState()
    const otherLabel = listManagedAgentDescriptors({ state, runtimes: {}, callerSessionId: OTHER_PROJECT_AGENT })
      .agents.find(item => item.agent.sessionId === OTHER_PROJECT_AGENT)!.agent.displayLabel!
    expect(otherLabel).toMatch(/^C\d+$/)
    const inOtherProject = resolveManagedTarget({ state, callerSessionId: CALLER, target: { label: otherLabel } })
    expect(() => assertManagedTarget({ state, callerSessionId: CALLER, sessionId: inOtherProject })).toThrow('agent_not_in_project')

    const terminalLabel = observeLabel(state, TERMINAL)
    const terminal = resolveManagedTarget({ state, callerSessionId: CALLER, target: { label: terminalLabel } })
    expect(terminal).toBe(TERMINAL)
    expect(() => assertManagedTarget({ state, callerSessionId: CALLER, sessionId: terminal })).toThrow('agent_not_found')

    // The caller's own label resolves to itself; send/close refuse it there.
    const own = resolveManagedTarget({ state, callerSessionId: CALLER, target: { label: observeLabel(state, CALLER) } })
    expect(() => assertManagedTarget({ state, callerSessionId: CALLER, sessionId: own })).toThrow('self_target_forbidden')
  })

  it('resolves at call time: closing an earlier row hands B28 to the next agent', () => {
    // WHY this is pinned: it is the property that makes resolve-at-call-time
    // correct AND that makes caching a label from an earlier listing wrong.
    // Removing any row before B28 renumbers everything after it.
    const state = recordedState()
    const { [CODEX.B5]: _closed, ...sessions } = state.sessions
    const after = { ...state, sessions }
    const now = resolveManagedTarget({ state: after, callerSessionId: CALLER, target: { label: 'B28' } })
    expect(now).not.toBe(CODEX.B28)
    expect(resolveManagedTarget({ state: after, callerSessionId: CALLER, target: { label: 'B27' } })).toBe(CODEX.B28)
  })

  it('resolves spoken names exactly, and refuses when off or ambiguous', () => {
    const state = recordedState()
    expect(resolveManagedTarget({ state, callerSessionId: CALLER, target: { name: '  apollo ' }, agentNames: namesOn(state) })).toBe(NAMED)
    expect(listManagedAgentDescriptors({ state, runtimes: {}, callerSessionId: CALLER, agentNames: namesOn(state) })
      .agents.find(item => item.agent.sessionId === NAMED)?.agent.agentName).toBe('Apollo')

    // Substrings are not names (the ac_agents_search rule).
    expect(refusal(() => resolveManagedTarget({ state, callerSessionId: CALLER, target: { name: 'Apol' }, agentNames: namesOn(state) })).code).toBe('name_not_found')
    // Setting off: the allocation exists but must not resolve, and the
    // refusal says why instead of "no such agent".
    const off = refusal(() => resolveManagedTarget({ state, callerSessionId: CALLER, target: { name: 'Apollo' } }))
    expect(off.code).toBe('name_not_found')
    expect(off.message).toContain('turned off')

    // A reload carries the identity to the replacement session; while both
    // rows exist the name names two sessions and must not pick one.
    const carried = { ...state, sessions: { ...state.sessions, [CODEX.B16]: { ...state.sessions[CODEX.B16]!, agentNameId: state.sessions[NAMED]!.agentNameId } } }
    expect(refusal(() => resolveManagedTarget({ state: carried, callerSessionId: CALLER, target: { name: 'Apollo' }, agentNames: namesOn(state) })).code).toBe('name_ambiguous')
  })

  it('refuses a target that names zero or several ways', () => {
    const state = recordedState()
    expect(refusal(() => resolveManagedTarget({ state, callerSessionId: CALLER, target: {} })).code).toBe('invalid_target')
    expect(refusal(() => resolveManagedTarget({ state, callerSessionId: CALLER, target: { sessionId: CODEX.B5, label: 'B16' } })).code).toBe('invalid_target')
  })
})

function observeLabel(state: WorkspaceState, sessionId: string): string {
  useAppStore.setState({ workspaceState: state, workspaceReaderMode: null, workspaceSpotlight: null, workspaceRuntimes: {} })
  return observeWorkspace(() => ({ restoreStatus: 'complete-restore' })).sessions.find(session => session.sessionId === sessionId)!.displayLabel!
}
