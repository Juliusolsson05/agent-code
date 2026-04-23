// Ghost-record demo against a real Claude Code transcript.
//
// Uses a real session JSONL from ~/.claude/projects, plus a ghost
// log we synthesize here to mimic what a live layer would write
// during streaming. Proves:
//
//   1. We can load a real transcript and count its turns.
//   2. We can create ghosts mimicking mid-flight assistant blocks,
//      update them with more content, then supersede them when the
//      real upstream record "arrives."
//   3. mergeWithUpstream drops superseded ghosts and keeps orphans.
//   4. Feeding the merged list through toCodex drops every ghost —
//      the exported rollout never contains a g- uuid.
//
// Run: npx tsx testing/ghost-demo/demo.mts

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createGhost,
  updateGhost,
  supersedeGhost,
  orphanGhost,
  reduceGhostLog,
  mergeWithUpstream,
  isGhost,
  toCodex,
} from '../../packages/agent-transcript-parser/dist/index.js'
import type {
  ClaudeEntry,
  GhostEntry,
} from '../../packages/agent-transcript-parser/dist/types.js'

// ---------------------------------------------------------------------------
// Pick a transcript
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const SESSION_PATH =
  process.env.GHOST_DEMO_TRANSCRIPT ??
  join(
    process.env.HOME ?? '',
    '.claude/projects/-Users-juliusolsson-Desktop-Development-cc-shell/019d8d68-c831-74c3-ab2a-ae4f0a61f840.jsonl',
  )

if (!existsSync(SESSION_PATH)) {
  console.error(`no transcript at ${SESSION_PATH}`)
  process.exit(1)
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

const upstream = readJsonl<ClaudeEntry>(SESSION_PATH)
const userCount = upstream.filter(
  e => e.type === 'user' && !(e as { isMeta?: boolean }).isMeta,
).length
const assistantCount = upstream.filter(e => e.type === 'assistant').length
const lastAssistant = [...upstream].reverse().find(e => e.type === 'assistant')

console.log('─'.repeat(72))
console.log('real transcript')
console.log('─'.repeat(72))
console.log(`  path            : ${SESSION_PATH}`)
console.log(`  entries         : ${upstream.length}`)
console.log(`  user (non-meta) : ${userCount}`)
console.log(`  assistant       : ${assistantCount}`)
console.log(
  `  last assistant  : ${
    lastAssistant
      ? `uuid=${lastAssistant.uuid.slice(0, 8)}… timestamp=${lastAssistant.timestamp}`
      : '(none)'
  }`,
)

// ---------------------------------------------------------------------------
// Simulate a live layer streaming a brand-new turn
// ---------------------------------------------------------------------------

const sessionId =
  typeof upstream[0]?.sessionId === 'string' ? upstream[0]!.sessionId : 'sess-demo'
const liveTurnId = 'turn-live-xyz'

// Ghost log we build up during the simulated stream. In production
// this would be appended to a .ghost.jsonl file; here we just keep
// it in memory.
const ghostLog: GhostEntry[] = []

let assistantGhost = createGhost({
  sessionId,
  turnId: liveTurnId,
  blockIndex: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'Looking at…' }],
  context: { pane: 'demo', source: 'simulated-live' },
})
ghostLog.push(assistantGhost)

// Two streaming updates.
assistantGhost = updateGhost(assistantGhost, [
  { type: 'text', text: 'Looking at the recent turns in this session.' },
])
ghostLog.push(assistantGhost)

assistantGhost = updateGhost(assistantGhost, [
  {
    type: 'text',
    text: `Looking at the recent turns in this session. Found ${assistantCount} committed assistant rows.`,
  },
])
ghostLog.push(assistantGhost)

// A second block on the same turn — e.g. a tool_use that the live
// layer saw happen before upstream wrote it.
const toolGhost = createGhost({
  sessionId,
  turnId: liveTurnId,
  blockIndex: 1,
  role: 'assistant',
  content: [
    {
      type: 'tool_use',
      id: 'toolu_live_01',
      name: 'Bash',
      input: { command: 'echo hello from ghost' },
    },
  ],
})
ghostLog.push(toolGhost)

// An orphaned ghost on a different turn — simulates a stream that
// never got its authoritative counterpart.
const orphanGhostInitial = createGhost({
  sessionId,
  turnId: 'turn-lost',
  blockIndex: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'This thought never made it to disk.' }],
})
ghostLog.push(orphanGhostInitial)
ghostLog.push(orphanGhost(orphanGhostInitial))

console.log()
console.log('─'.repeat(72))
console.log('simulated ghost log')
console.log('─'.repeat(72))
console.log(`  writes appended : ${ghostLog.length}`)

// Reduce log into current state.
const ghostState = reduceGhostLog(ghostLog)
console.log(`  distinct ghosts : ${ghostState.size}`)
for (const [uuid, g] of ghostState) {
  const sidecar = g._atp
  const tag = sidecar.supersededBy
    ? 'superseded'
    : sidecar.orphanedAt
      ? 'orphaned'
      : 'pending'
  console.log(
    `    ${uuid}  [${tag}]  updatedAt=${sidecar.updatedAt}  blocks=${
      Array.isArray(g.message?.content) ? g.message!.content.length : 0
    }`,
  )
}

// ---------------------------------------------------------------------------
// Merge: upstream as-is, ghosts trailing
// ---------------------------------------------------------------------------

const merged = mergeWithUpstream(upstream, ghostState)
const ghostsInMerged = merged.filter(isGhost)
console.log()
console.log('─'.repeat(72))
console.log('merge: upstream + ghosts (no supersede yet)')
console.log('─'.repeat(72))
console.log(`  merged length       : ${merged.length}`)
console.log(`  ghosts in merged    : ${ghostsInMerged.length}`)
console.log('  ghost tail:')
for (const g of ghostsInMerged) {
  console.log(
    `    ${g.uuid}  updatedAt=${g._atp.updatedAt}  orphan=${g._atp.orphanedAt !== undefined}`,
  )
}

// ---------------------------------------------------------------------------
// Supersede the text ghost — simulate upstream write landing
// ---------------------------------------------------------------------------

const fakeRealUuid = 'real-upstream-01'
const supersededText = supersedeGhost(assistantGhost, fakeRealUuid)
ghostLog.push(supersededText)

const ghostState2 = reduceGhostLog(ghostLog)

// Inject a synthesized upstream entry that shares the real uuid.
const fakeUpstream: ClaudeEntry[] = [
  ...upstream,
  {
    type: 'assistant',
    uuid: fakeRealUuid,
    parentUuid: lastAssistant?.uuid ?? null,
    sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Looking at the recent turns in this session. Found ${assistantCount} committed assistant rows.`,
        },
      ],
    },
  },
]
const merged2 = mergeWithUpstream(fakeUpstream, ghostState2)
const ghostsAfter = merged2.filter(isGhost)

console.log()
console.log('─'.repeat(72))
console.log('merge: after supersedeGhost(text → real-upstream-01)')
console.log('─'.repeat(72))
console.log(`  upstream entries       : ${fakeUpstream.length}`)
console.log(`  merged length          : ${merged2.length}`)
console.log(`  ghosts in merged       : ${ghostsAfter.length}`)
console.log(
  `  text ghost suppressed? : ${!ghostsAfter.some(g => g.uuid === assistantGhost.uuid)}`,
)
console.log(
  `  tool ghost still shown?: ${ghostsAfter.some(g => g.uuid === toolGhost.uuid)}`,
)
console.log(
  `  orphan still shown?    : ${ghostsAfter.some(g => g.uuid === orphanGhostInitial.uuid)}`,
)

// ---------------------------------------------------------------------------
// Export: converter must drop every ghost
// ---------------------------------------------------------------------------

const exported = toCodex(merged2)
const exportedHasGhost = JSON.stringify(exported).includes('"g-')

console.log()
console.log('─'.repeat(72))
console.log('export: toCodex(merged)')
console.log('─'.repeat(72))
console.log(`  codex lines emitted      : ${exported.length}`)
console.log(`  any "g-" uuid in output? : ${exportedHasGhost}`)
console.log(
  `  any _atp origin:'ghost' ? : ${JSON.stringify(exported).includes(
    '"origin":"ghost"',
  )}`,
)

console.log()
if (exportedHasGhost || JSON.stringify(exported).includes('"origin":"ghost"')) {
  console.error('FAIL: ghost leaked into exported Codex rollout')
  process.exit(1)
}
console.log('OK: ghosts were present during render, absent from export.')
