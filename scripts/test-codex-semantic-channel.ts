import assert from 'node:assert/strict'

import { SemanticChannel } from '../packages/codex-headless/src/channels/SemanticChannel'
import type { SemanticEvent } from '../packages/codex-headless/src/channels/types'

const channel = new SemanticChannel()
const events: SemanticEvent[] = []
channel.on('event', event => events.push(event))

channel.startTurn({
  turnId: 'resp_stale',
  role: 'assistant',
  source: 'proxy',
})

channel.finishTurn({
  turnId: 'resp_actual',
  source: 'proxy',
})

assert.equal(events.at(-2)?.type, 'lifecycle_violation')
assert.equal(events.at(-1)?.type, 'turn_completed')
assert.equal(events.at(-1)?.turnId, 'resp_actual')

// WHY the stale active slot must be released after a mismatched finish:
// the 2026-05-16T19:15 debug bundle showed the renderer receiving all
// block events for a fresh `resp_*`, then only `usage_updated` at the
// terminal boundary. The channel had dropped `turn_completed` because
// its private `activeTurnId` still pointed at an older response, and
// that left `currentTurn.endedAt === null` in the UI. If we publish the
// terminal event but keep the stale slot, the next turn repeats the
// same failure forever. A clean start here proves the mismatch was
// contained to one diagnostic event plus one forwarded completion.
channel.startTurn({
  turnId: 'resp_next',
  role: 'assistant',
  source: 'proxy',
})

assert.equal(events.at(-1)?.type, 'turn_started')
assert.equal(events.at(-1)?.turnId, 'resp_next')

console.log('codex semantic channel lifecycle tests passed')
