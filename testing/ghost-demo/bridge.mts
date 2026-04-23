// Smoke test for the cc-shell ghost bridge.
//
// Exercises the pure-function surface area used by `workspaceStore`:
//   1. `ghostsFromSemanticTurn` — builds a ghost map from a fabricated
//      `SemanticLiveTurn` (text block + tool_use block).
//   2. Feed merging via atp's `mergeWithUpstream` — ghosts appear in
//      the merged tail.
//   3. `reconcileUpstream` — when a matching upstream entry lands,
//      ghost gets `supersededBy` and drops from merged.
//   4. `orphanStale` — ghost passes the TTL and is flagged.
//   5. `ghostsToPersist` — diff between maps produces the ghosts that
//      need an IPC append.
//   6. Converter skip — a feed that contains ghosts exports cleanly
//      through `toCodex` with no `g-` uuids on the wire.
//
// Run: npx tsx testing/ghost-demo/bridge.mts

import {
  mergeWithUpstream,
  reduceGhostLog,
  toCodex,
  type ClaudeEntry,
  type GhostEntry,
} from '../../agent-transcript-parser/dist/index.js'

import {
  ghostsFromSemanticTurn,
  ghostsToPersist,
  orphanStale,
  reconcileUpstream,
} from '@renderer/workspace/ghosts.js'
import type {
  SemanticLiveTurn,
  SemanticLiveBlock,
} from '@renderer/workspace/workspaceState.js'
import type { Entry } from '@shared/types/transcript.js'

let failed = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`✓ ${label}`)
  else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// Fabricate a SemanticLiveTurn
// ---------------------------------------------------------------------------

function semanticBlock(
  partial: Partial<SemanticLiveBlock> & Pick<SemanticLiveBlock, 'blockIndex' | 'kind'>,
): SemanticLiveBlock {
  return {
    text: '',
    thinking: '',
    inputJson: '',
    ...partial,
  } as SemanticLiveBlock
}

function makeTurn(turnId: string, blocks: SemanticLiveBlock[]): SemanticLiveTurn {
  const blockMap: Record<number, SemanticLiveBlock> = {}
  const order: number[] = []
  for (const b of blocks) {
    blockMap[b.blockIndex] = b
    order.push(b.blockIndex)
  }
  return {
    turnId,
    text: '',
    source: 'proxy',
    blocks: blockMap,
    blockOrder: order,
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
    startedAt: Date.now(),
    endedAt: null,
  }
}

// ---------------------------------------------------------------------------
// 1. ghostsFromSemanticTurn → mint + update
// ---------------------------------------------------------------------------

const sessionId = 'sess-bridge-demo'
const turnId = 'msg_abcdef'

const turnV1 = makeTurn(turnId, [
  semanticBlock({ blockIndex: 0, kind: 'text', text: 'Starting…' }),
  semanticBlock({
    blockIndex: 1,
    kind: 'tool_use',
    toolName: 'Bash',
    toolUseId: 'toolu_01',
    inputJson: '{"command":"ls"}',
    parsedInput: { command: 'ls' },
  }),
])

const ghostsV1 = ghostsFromSemanticTurn(turnV1, sessionId, new Map())

check('mints one ghost per translatable block', ghostsV1.size === 2)
check(
  'ghost uuids follow g-<turnId>-<blockIndex>',
  ghostsV1.has(`g-${turnId}-0`) && ghostsV1.has(`g-${turnId}-1`),
)
check(
  'text ghost has a text block',
  (ghostsV1.get(`g-${turnId}-0`)!.message!.content as Array<{ type: string }>)[0]!
    .type === 'text',
)
check(
  'tool_use ghost has a tool_use block with id',
  (ghostsV1.get(`g-${turnId}-1`)!.message!.content as Array<{
    type: string
    id?: string
  }>)[0]!.id === 'toolu_01',
)

// Second tick — text grows, tool_use unchanged.
const turnV2 = makeTurn(turnId, [
  semanticBlock({ blockIndex: 0, kind: 'text', text: 'Starting. Read the file.' }),
  semanticBlock({
    blockIndex: 1,
    kind: 'tool_use',
    toolName: 'Bash',
    toolUseId: 'toolu_01',
    inputJson: '{"command":"ls"}',
    parsedInput: { command: 'ls' },
  }),
])

const ghostsV2 = ghostsFromSemanticTurn(turnV2, sessionId, ghostsV1)

check(
  'text ghost is updated (same uuid, new updatedAt)',
  ghostsV2.get(`g-${turnId}-0`)!._atp.updatedAt >=
    ghostsV1.get(`g-${turnId}-0`)!._atp.updatedAt &&
    ghostsV2.get(`g-${turnId}-0`)!.uuid ===
      ghostsV1.get(`g-${turnId}-0`)!.uuid,
)
check(
  'tool_use ghost is reference-equal (churn-free update skipped)',
  ghostsV2.get(`g-${turnId}-1`) === ghostsV1.get(`g-${turnId}-1`),
)

// ---------------------------------------------------------------------------
// 2. Merge — ghosts appear after upstream entries
// ---------------------------------------------------------------------------

const upstreamBefore: ClaudeEntry[] = []
const merged = mergeWithUpstream(upstreamBefore, ghostsV2) as ClaudeEntry[]
check('merged list contains both ghosts when no upstream', merged.length === 2)

// ---------------------------------------------------------------------------
// 3. reconcileUpstream — supersede by message.id
// ---------------------------------------------------------------------------

const upstreamAssistant: ClaudeEntry = {
  type: 'assistant',
  uuid: 'real-uuid-42',
  parentUuid: null,
  sessionId,
  timestamp: new Date().toISOString(),
  message: {
    id: turnId,
    role: 'assistant',
    content: [
      { type: 'text', text: 'Starting. Read the file.' },
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ],
  },
} as ClaudeEntry

const reconciled = reconcileUpstream(upstreamAssistant, ghostsV2)

check(
  'reconcile supersedes every ghost for the turn (message.id match)',
  [...reconciled.values()].every(g => g._atp.supersededBy === 'real-uuid-42'),
)

const mergedAfter = mergeWithUpstream([upstreamAssistant], reconciled) as ClaudeEntry[]
check(
  'merged tail no longer contains ghosts after supersede',
  mergedAfter.length === 1 && mergedAfter[0]!.uuid === 'real-uuid-42',
)

// ---------------------------------------------------------------------------
// 4. orphanStale — past TTL, ghost is flagged
// ---------------------------------------------------------------------------

const lostTurn = makeTurn('turn-lost', [
  semanticBlock({ blockIndex: 0, kind: 'text', text: 'vanished mid-flight' }),
])
const orphaned = orphanStale(
  ghostsFromSemanticTurn(lostTurn, sessionId, new Map()),
  Date.now() + 60_000,
  1_000,
)
check(
  'orphanStale flags stale ghosts',
  [...orphaned.values()].every(g => g._atp.orphanedAt !== undefined),
)

// ---------------------------------------------------------------------------
// 5. ghostsToPersist — diff produces the writes
// ---------------------------------------------------------------------------

const toWriteV1 = ghostsToPersist(new Map(), ghostsV1)
check('first tick persists both ghosts', toWriteV1.length === 2)

const toWriteV2 = ghostsToPersist(ghostsV1, ghostsV2)
check(
  'second tick persists only the updated text ghost',
  toWriteV2.length === 1 && toWriteV2[0]!.uuid === `g-${turnId}-0`,
)

const toWriteSupersede = ghostsToPersist(ghostsV2, reconciled)
check(
  'supersede tick persists every newly-superseded ghost',
  toWriteSupersede.length === 2 &&
    toWriteSupersede.every(g => g._atp.supersededBy === 'real-uuid-42'),
)

// ---------------------------------------------------------------------------
// 6. reduceGhostLog replays append-only log to current state
// ---------------------------------------------------------------------------

const replayLog: GhostEntry[] = [
  ...toWriteV1,
  ...toWriteV2,
  ...toWriteSupersede,
]
const replayed = reduceGhostLog(replayLog)
check(
  'reduceGhostLog reconstructs current state from append-only writes',
  replayed.size === 2 &&
    [...replayed.values()].every(g => g._atp.supersededBy === 'real-uuid-42'),
)

// ---------------------------------------------------------------------------
// 7. Export — converter drops ghosts
// ---------------------------------------------------------------------------

const exportedCodex = toCodex(mergedAfter)
const raw = JSON.stringify(exportedCodex)
check(
  'toCodex export contains no ghost uuids',
  !raw.includes('"g-msg_abcdef-') && !raw.includes('"origin":"ghost"'),
)

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\nAll ghost-bridge checks passed')
