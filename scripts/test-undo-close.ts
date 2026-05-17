import assert from 'node:assert/strict'

import {
  findParentSplitInfo,
  reinsertPane,
  UNDO_CLOSE_MAX_ENTRIES,
  UNDO_CLOSE_RETENTION_MS,
  UndoCloseStack,
  type ClosedEntry,
} from '../src/renderer/src/lib/undoClose'
import { collectLeaves } from '../src/renderer/src/workspace/tile-tree/treeOps'
import type { SessionId, SessionMeta, TileNode } from '../src/renderer/src/workspace/types'

const meta = (id: string): SessionMeta => ({
  cwd: `/tmp/${id}`,
  kind: 'claude',
})

const poppedPaneName = (entry: ClosedEntry | null): string | null => {
  assert.ok(entry === null || entry.type === 'pane')
  return entry ? entry.sessionMeta.cwd.split('/').pop() ?? null : null
}

const paneEntry = (
  id: string,
  closedAt: number,
  siblingLeafId: string = 'anchor',
): ClosedEntry => ({
  type: 'pane',
  closedAt,
  tabId: 'tab',
  sessionMeta: meta(id),
  direction: 'vertical',
  ratio: 0.5,
  side: 'b',
  siblingLeafId: siblingLeafId as SessionId,
})

{
  let now = 1_000
  const stack = new UndoCloseStack(() => now)

  for (let i = 0; i < UNDO_CLOSE_MAX_ENTRIES + 3; i += 1) {
    stack.push(paneEntry(`closed-${i}`, now + i))
  }

  assert.equal(stack.length, UNDO_CLOSE_MAX_ENTRIES)
  assert.equal(poppedPaneName(stack.pop()), 'closed-12')
  assert.equal(poppedPaneName(stack.pop()), 'closed-11')
}

{
  let now = 10_000
  const stack = new UndoCloseStack(() => now)
  stack.push(paneEntry('old', now - UNDO_CLOSE_RETENTION_MS - 1))
  stack.push(paneEntry('fresh', now - UNDO_CLOSE_RETENTION_MS + 1))

  assert.equal(stack.length, 1)
  assert.equal(poppedPaneName(stack.peek()), 'fresh')

  now += 2
  assert.equal(stack.pop(), null)
}

{
  const stack = new UndoCloseStack(() => 5_000)
  stack.push(paneEntry('first', 4_900))
  stack.push(paneEntry('second', 4_901))
  stack.push(paneEntry('third', 4_902))

  assert.equal(poppedPaneName(stack.pop()), 'third')
  assert.equal(poppedPaneName(stack.pop()), 'second')
  assert.equal(poppedPaneName(stack.pop()), 'first')
  assert.equal(stack.pop(), null)
}

{
  const root: TileNode = {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.35,
    a: { type: 'leaf', sessionId: 'closed' as SessionId },
    b: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      a: { type: 'leaf', sessionId: 'anchor-a' as SessionId },
      b: { type: 'leaf', sessionId: 'anchor-b' as SessionId },
    },
  }

  const parentInfo = findParentSplitInfo(root, 'closed' as SessionId)
  assert.deepEqual(parentInfo, {
    direction: 'horizontal',
    ratio: 0.35,
    side: 'a',
    siblingLeafId: 'anchor-a',
  })

  const restored = reinsertPane(
    root.b,
    'anchor-a' as SessionId,
    'restored' as SessionId,
    parentInfo!.direction,
    parentInfo!.ratio,
    parentInfo!.side,
  )

  assert.ok(restored)
  assert.deepEqual(collectLeaves(restored), ['restored', 'anchor-a', 'anchor-b'])
}

{
  const root: TileNode = { type: 'leaf', sessionId: 'only' as SessionId }

  assert.equal(
    reinsertPane(
      root,
      'missing-anchor' as SessionId,
      'restored' as SessionId,
      'vertical',
      0.5,
      'b',
    ),
    null,
  )
}

{
  const stack = new UndoCloseStack(() => 5_000)
  stack.push(paneEntry('older-valid', 4_900, 'anchor'))
  stack.push(paneEntry('newer-stale', 4_901, 'missing-anchor'))

  const currentRoot: TileNode = { type: 'leaf', sessionId: 'anchor' as SessionId }
  const skippedStale = stack.pop()
  assert.equal(poppedPaneName(skippedStale), 'newer-stale')
  assert.ok(skippedStale?.type === 'pane')
  assert.equal(
    reinsertPane(
      currentRoot,
      skippedStale!.siblingLeafId,
      'restored-stale' as SessionId,
      skippedStale!.direction,
      skippedStale!.ratio,
      skippedStale!.side,
    ),
    null,
  )

  const older = stack.pop()
  assert.equal(poppedPaneName(older), 'older-valid')
  assert.ok(older?.type === 'pane')
  assert.ok(
    reinsertPane(
      currentRoot,
      older!.siblingLeafId,
      'restored-valid' as SessionId,
      older!.direction,
      older!.ratio,
      older!.side,
    ),
  )
}
