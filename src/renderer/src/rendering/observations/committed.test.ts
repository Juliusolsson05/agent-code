import { describe, expect, it } from 'vitest'

import {
  buildCommittedOwnership,
  decideLiveCandidate,
  SUPPRESSION_POLICY,
} from '@renderer/rendering/model/ownership'
import type { RenderCandidate } from '@renderer/rendering/model/types'

import {
  collectCommittedCandidates,
  normalizeTextKey,
} from '@renderer/rendering/observations/committed'
import type { RawCommittedEntry } from '@renderer/rendering/observations/committed'

// Fixture times are explicit ISO strings — entry.timestamp is producer
// wall-clock and the collector must parse it, never substitute Date.now().
const TS = '2026-07-06T12:00:00.000Z'
const TS_MS = Date.parse(TS)

const user = (over: Partial<RawCommittedEntry> = {}): RawCommittedEntry => ({
  uuid: 'u1',
  type: 'user',
  timestamp: TS,
  permissionMode: 'default',
  message: { role: 'user', content: 'hello' },
  ...over,
})

describe('committed collector: visibility (#338, meta, non-conversation)', () => {
  it('ordinary conversation rows become candidates with producer timestamps', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [user(), { uuid: 'a1', type: 'assistant', timestamp: TS, message: { id: 'msg_1', role: 'assistant', content: 'hi' } }],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:u1', 'entry:a1'])
    expect(candidates[0].timestampMs).toBe(TS_MS)
    expect(candidates[1].messageId).toBe('msg_1')
    expect(decisions.every(d => d.selected)).toBe(true)
  })

  it('meta rows and non-conversation rows are hidden WITH reasons, not dropped silently', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [
        user({ uuid: 'meta', isMeta: true }),
        { uuid: 'sys', type: 'system', timestamp: TS },
      ],
      'claude',
      's1',
    )
    expect(candidates).toHaveLength(0)
    expect(decisions.map(d => d.reason).sort()).toEqual(['meta-entry', 'not-conversation'])
  })

  it('#338: claude command scaffolding (<command-name>, <local-command-stdout>) filtered as synthetic-user', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [
        user({ uuid: 'cmd', permissionMode: undefined, message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
        user({ uuid: 'out', permissionMode: undefined, message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } }),
        user({ uuid: 'real' }), // has permissionMode → real prompt
      ],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:real'])
    expect(decisions.filter(d => d.reason === 'synthetic-user-filtered')).toHaveLength(2)
  })

  it('#338 is claude-scoped: an opencode user message starting with "<" (pasted HTML) is NOT hidden', () => {
    const { candidates } = collectCommittedCandidates(
      [user({ uuid: 'html', permissionMode: undefined, message: { role: 'user', content: '<div>paste</div>' } })],
      'opencode',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:html'])
  })

  it('compact boundary/summary rows are visible', () => {
    const { candidates } = collectCommittedCandidates(
      [
        { uuid: 'b', type: 'compact-boundary', timestamp: TS },
        { uuid: 's', type: 'compact-summary', timestamp: TS },
      ],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.contentKind)).toEqual(['compact-boundary', 'compact-summary'])
  })

  it('assistant rows carry exact + normalized text keys; user rows carry neither', () => {
    const { candidates } = collectCommittedCandidates(
      [
        { uuid: 'a', type: 'assistant', timestamp: TS, message: { role: 'assistant', content: '  Same  answer ' } },
        user(),
      ],
      'codex',
      's1',
    )
    const assistant = candidates.find(c => c.id === 'entry:a')
    expect(assistant?.textKey).toBe('  Same  answer ')
    expect(assistant?.normalizedTextKey).toBe(normalizeTextKey('Same answer'))
    expect(candidates.find(c => c.id === 'entry:u1')?.textKey).toBeUndefined()
  })

  it('uuid-less entries get an INGEST-position id, never a visible-index id', () => {
    const { candidates } = collectCommittedCandidates(
      [{ type: 'user', timestamp: TS, permissionMode: 'default', message: { role: 'user', content: 'x' } }],
      'claude',
      's1',
    )
    expect(candidates[0].id).toBe('entry:ingest-0')
  })
})

describe('block-grain tool ownership mining (corpus new-bug fix)', () => {
  it('mines tool_use ids from assistant entries and tool_result ids from user entries', () => {
    const { candidates } = collectCommittedCandidates(
      [
        {
          uuid: 'a-tools',
          type: 'assistant',
          timestamp: TS,
          message: {
            id: 'msg_t',
            role: 'assistant',
            content: [
              { type: 'text', text: 'running two tools' },
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
              { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} },
            ],
          },
        },
        {
          uuid: 'u-result',
          type: 'user',
          timestamp: TS,
          permissionMode: 'default',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        },
      ],
      'claude',
      's1',
    )
    expect(candidates.find(c => c.id === 'entry:a-tools')?.ownedToolUseIds).toEqual(['toolu_1', 'toolu_2'])
    expect(candidates.find(c => c.id === 'entry:u-result')?.ownedToolResultIds).toEqual(['toolu_1'])
  })

  it('mined evidence populates ownership sets so live tool blocks yield (the duplicate-tool-card class)', () => {
    const { candidates } = collectCommittedCandidates(
      [
        {
          uuid: 'a-tools',
          type: 'assistant',
          timestamp: TS,
          message: {
            id: 'msg_t',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
          },
        },
      ],
      'claude',
      's1',
    )
    const ownership = buildCommittedOwnership(candidates)
    expect(ownership.toolUseIds.has('toolu_1')).toBe(true)

    // The live twin of that tool block must now be rejected — before this
    // fix, claude committed candidates never exposed tool ids and this
    // decision came back selected (duplicate AskUserQuestion capture).
    const live: RenderCandidate = {
      id: 'sem:msg_t:1',
      owner: 'semantic-current',
      provider: 'claude',
      sourcePlane: 'semantic',
      sessionId: 's1',
      turnId: 'msg_t',
      blockIndex: 1,
      toolUseId: 'toolu_1',
      contentKind: 'tool-use',
      timestampMs: TS_MS,
      sequence: 0,
    }
    const d = decideLiveCandidate(live, ownership, SUPPRESSION_POLICY.claude)
    expect(d.selected).toBe(false)
    expect(d.reason).toBe('committed-tool-use-owned')
  })
})

describe('collapsed-running null-paint (corpus new-bug fix, claude churn tools)', () => {
  const emptyOwnership = buildCommittedOwnership([])
  const historyTool = (over: Partial<RenderCandidate>): RenderCandidate => ({
    id: 'sem:turn_h:0',
    owner: 'semantic-history',
    provider: 'claude',
    sourcePlane: 'semantic',
    sessionId: 's1',
    turnId: 'turn_h',
    blockIndex: 0,
    toolUseId: 'toolu_dangling',
    contentKind: 'tool-use',
    timestampMs: TS_MS,
    sequence: 0,
    ...over,
  })

  it('hides an unresolved untraced churn tool ONLY when committed truth moved past its turn', () => {
    // Dead run: committed tail is NEWER than the turn's end, yet no trace
    // of this tool anywhere — provably dangling (1b2b5e96 class).
    const dead = decideLiveCandidate(
      historyTool({ toolName: 'Read' }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
      TS_MS + 60_000,
    )
    expect(dead.selected).toBe(false)
    expect(dead.reason).toBe('collapsed-running')
  })

  it('in-flight fan-out stays visible while committed lags (2026-07-07 soak catch)', () => {
    // Committed tail BEHIND the turn: normal streaming lag, not death.
    // The v1 rule suppressed here and live Read/Bash fan-outs vanished
    // mid-run — "they get sent but then they just go away".
    const lagging = decideLiveCandidate(
      historyTool({ toolName: 'Read' }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
      TS_MS - 5_000,
    )
    expect(lagging.selected).toBe(true)
    // No tail info at all (fresh session) must also paint.
    const fresh = decideLiveCandidate(
      historyTool({ toolName: 'Bash' }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
      null,
    )
    expect(fresh.selected).toBe(true)
  })

  it('lookup-completed counts as resolved even past the tail (finished, result rode committed rows)', () => {
    const d = decideLiveCandidate(
      historyTool({ toolName: 'Read', resolved: true }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
      TS_MS + 60_000,
    )
    expect(d.selected).toBe(true)
  })

  it('non-churn tools paint even while unresolved (running Task chip is live signal)', () => {
    const d = decideLiveCandidate(historyTool({ toolName: 'Task' }), emptyOwnership, SUPPRESSION_POLICY.claude)
    expect(d.selected).toBe(true)
  })

  it('resolved churn tools paint (block-local result evidence)', () => {
    const d = decideLiveCandidate(
      historyTool({ toolName: 'Bash', resolved: true }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
    )
    expect(d.selected).toBe(true)
  })

  it('codex is exempt by policy (MCP next-turn-output lifecycle)', () => {
    const d = decideLiveCandidate(
      historyTool({ provider: 'codex', toolName: 'Read' }),
      emptyOwnership,
      SUPPRESSION_POLICY.codex,
    )
    expect(d.selected).toBe(true)
  })

  it('current-turn tools always paint (streaming legitimately awaits results)', () => {
    const d = decideLiveCandidate(
      historyTool({ owner: 'semantic-current', toolName: 'Read' }),
      emptyOwnership,
      SUPPRESSION_POLICY.claude,
    )
    expect(d.selected).toBe(true)
  })
})

describe('task-notification carve-out (residue plan P0b — cutover blocker)', () => {
  const notification = (uuid: string, body: string) => ({
    uuid,
    type: 'user',
    timestamp: TS,
    message: { role: 'user', content: body },
  })

  it('keeps task-notification rows visible despite matching the synthetic-filter shape', () => {
    const body =
      '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_bg1</tool-use-id>\n<status>completed</status>\n<result>done</result>\n</task-notification>'
    const { candidates, decisions } = collectCommittedCandidates(
      [notification('n1', body)],
      'claude',
      's1',
    )
    const c = candidates.find(x => x.id === 'entry:n1')
    expect(c).toBeDefined()
    expect(c?.toolUseId).toBe('toolu_bg1')
    expect(decisions.find(d => d.candidateId === 'entry:n1')?.selected).toBe(true)
  })

  it('does not weaken the synthetic filter for actual sidecar junk', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [notification('junk', '<command-name>/compact</command-name>')],
      'claude',
      's1',
    )
    expect(candidates.find(x => x.id === 'entry:junk')).toBeUndefined()
    expect(decisions.find(d => d.candidateId === 'entry:junk')?.reason).toBe('synthetic-user-filtered')
  })

  it('tolerates a notification without a tool-use-id tag', () => {
    const { candidates } = collectCommittedCandidates(
      [notification('n2', '<task-notification><status>completed</status></task-notification>')],
      'claude',
      's1',
    )
    const c = candidates.find(x => x.id === 'entry:n2')
    expect(c).toBeDefined()
    expect(c?.toolUseId).toBeUndefined()
  })
})

describe('sidechain (subagent) entry filtering (issue #477 — feed leak)', () => {
  // Claude interleaves a subagent's OWN turns into the PARENT transcript
  // tagged isSidechain:true. Their activity already renders inside the Task
  // card (watcher channel); painting them as main-feed rows is duplication.
  // These tests encode the FIX: sidechain entries must be rejected with
  // 'sidechain-filtered', and their inner tools must NOT be mined as
  // committed-owned (which would suppress the parent's real live tools).
  const sidechainAssistant = {
    uuid: 'sc-a1',
    type: 'assistant',
    isSidechain: true,
    timestamp: TS,
    message: {
      id: 'msg_sc',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read the key files.' },
        { type: 'tool_use', id: 'toolu_sc', name: 'Read', input: { file_path: '/x.ts' } },
      ],
    },
  }

  it('rejects a sidechain assistant turn instead of painting it in the main feed', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [sidechainAssistant],
      'claude',
      's1',
    )
    expect(candidates.find(c => c.id === 'entry:sc-a1')).toBeUndefined()
    const d = decisions.find(x => x.candidateId === 'entry:sc-a1')
    expect(d?.selected).toBe(false)
    expect(d?.reason).toBe('sidechain-filtered')
  })

  it('does NOT mine a sidechain turn\'s inner tools as committed-owned', () => {
    const { candidates } = collectCommittedCandidates([sidechainAssistant], 'claude', 's1')
    const ownership = buildCommittedOwnership(candidates)
    // toolu_sc belongs to the subagent — it must not suppress a parent live
    // tool block that happens to share nothing, and must not be claimed here.
    expect(ownership.toolUseIds.has('toolu_sc')).toBe(false)
  })

  it('a normal (non-sidechain) assistant turn still paints', () => {
    const { candidates } = collectCommittedCandidates(
      [{ ...sidechainAssistant, uuid: 'normal', isSidechain: false }],
      'claude',
      's1',
    )
    expect(candidates.find(c => c.id === 'entry:normal')).toBeDefined()
  })
})
