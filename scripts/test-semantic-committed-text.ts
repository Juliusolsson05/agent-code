// TEMPORARY RENDERING REGRESSION SCRIPT.
//
// WHY this file is allowed to exist even though it is not the testing
// shape we want long-term:
// these focused scripts were added during the 2026-05 rendering rewrite
// because we needed executable guards immediately while the feed ownership
// bugs were still active. They are intentionally small and useful, but
// they are also messy compared with the proper unit/integration suite we
// want: no standard runner, no shared fixtures, and too much local test
// scaffolding per file. Keep them until #182 establishes the app-wide
// testing suite and #183 migrates/expands the rendering regression coverage
// into that structure.

import assert from 'node:assert/strict'

import type { Entry } from '../src/shared/types/transcript'
import type { SemanticLiveTurn } from '../src/renderer/src/workspace/workspaceState'
import {
  buildSemanticRenderUnits,
  type CommittedAssistantText,
} from '../src/renderer/src/features/feed/ui/semantic/renderUnits'

const DUPED_TEXT =
  "I’ll inspect the repo’s top-level files first, then read the core docs and entry points to summarize what the project does and how it’s structured."

function committedAssistantText(entries: Entry[]): CommittedAssistantText {
  const keys = new Set<string>()
  const texts = new Set<string>()

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const record = entry as {
      codexTurnId?: unknown
      message?: { id?: unknown; content?: unknown }
    }
    const turnIds = [
      typeof record.message?.id === 'string' ? record.message.id : null,
      typeof record.codexTurnId === 'string' ? record.codexTurnId : null,
    ].filter((id): id is string => Boolean(id))

    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const item = block as Record<string, unknown>
      if (item.type !== 'text' || typeof item.text !== 'string' || !item.text) continue
      texts.add(item.text)
      for (const turnId of turnIds) keys.add(`${turnId}\u0000${item.text}`)
    }
  }

  return { keys, texts }
}

function liveTurn(turnId: string, text: string): SemanticLiveTurn {
  return {
    turnId,
    text: '',
    source: 'proxy',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'message',
        itemId: 'msg_009dff73e265ae8a016a08aea75dd4819181402cf6437a290b',
        messagePhase: 'commentary',
        status: 'completed',
        text,
        thinking: '',
        inputJson: '',
        finalized: true,
      },
    },
    blockOrder: [0],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    lookups: {
      toolCallsById: {},
      toolUseIdsInOrder: [],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
    startedAt: 1,
    endedAt: null,
  }
}

// Regression fixture from:
// ~/.config/agent-code/debug-bundles/2026-05-16T17-51-43-433-f2395303/html-clean.html
//
// Raw HTML had the same assistant paragraph twice:
// 1. committed transcript row:
//    data-entry-uuid="2026-05-16T17:51:37.605Z:message"
// 2. live SemanticStreamingTurn row below committed tool results.
//
// The committed row is stamped with Codex rollout/task id
// `019e31ea-...`; the live semantic row is keyed by proxy Responses
// id `resp_009dff...`. Turn-scoped suppression alone cannot connect
// those ids, so exact committed text must also suppress finalized
// live text blocks.
{
  const committed: Entry[] = [
    {
      type: 'assistant',
      uuid: '2026-05-16T17:51:37.605Z:message',
      parentUuid: null,
      timestamp: '2026-05-16T17:51:37.605Z',
      codexTurnId: '019e31ea-2d36-7753-bd78-2a629e5e46ac',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: DUPED_TEXT }],
      },
    } as Entry,
  ]

  const units = buildSemanticRenderUnits(
    liveTurn('resp_009dff73e265ae8a016a08aea6841081918e34c47fabb83059', DUPED_TEXT),
    new Map(),
    committedAssistantText(committed),
  )

  assert.deepEqual(units, [], 'committed text must suppress finalized live text across Codex id split')
}

{
  const committed: Entry[] = [
    {
      type: 'assistant',
      uuid: 'same-turn:message',
      parentUuid: null,
      timestamp: '2026-05-16T17:51:37.605Z',
      message: {
        id: 'same-turn',
        role: 'assistant',
        content: [{ type: 'text', text: DUPED_TEXT }],
      },
    } as Entry,
  ]

  const units = buildSemanticRenderUnits(
    liveTurn('same-turn', DUPED_TEXT),
    new Map(),
    committedAssistantText(committed),
  )

  assert.deepEqual(units, [], 'same-turn committed text suppression still works')
}

{
  const committed: Entry[] = [
    {
      type: 'assistant',
      uuid: 'older:message',
      parentUuid: null,
      timestamp: '2026-05-16T17:51:37.605Z',
      message: {
        id: 'older-turn',
        role: 'assistant',
        content: [{ type: 'text', text: DUPED_TEXT }],
      },
    } as Entry,
  ]

  const units = buildSemanticRenderUnits(
    liveTurn('new-turn', `${DUPED_TEXT} Extra live text still streaming.`),
    new Map(),
    committedAssistantText(committed),
  )

  assert.equal(units.length, 1, 'non-identical live text must still render')
}
