import assert from 'node:assert/strict'

import { remapSessionMetaRelationships } from '../src/renderer/src/workspace/hook/persistence/rehydrate'
import type { SessionMeta } from '../src/renderer/src/workspace/types'

{
  const meta: SessionMeta = {
    cwd: '/repo',
    kind: 'codex',
    providerSessionId: 'provider-child',
    linkedParentId: 'linked-parent-old',
    orchestrationParentId: 'orchestration-parent-old',
    orchestrationRootId: 'orchestration-root-old',
    orchestrationRunId: 'run-1',
    orchestrationRole: 'reviewer',
    builtInMcpDomains: ['orchestration'],
  }

  const remapped = remapSessionMetaRelationships(
    meta,
    new Map([
      ['linked-parent-old', 'linked-parent-new'],
      ['orchestration-parent-old', 'orchestration-parent-new'],
      ['orchestration-root-old', 'orchestration-root-new'],
    ]),
  )

  assert.equal(remapped.linkedParentId, 'linked-parent-new')
  assert.equal(remapped.orchestrationParentId, 'orchestration-parent-new')
  assert.equal(remapped.orchestrationRootId, 'orchestration-root-new')
  assert.equal(remapped.orchestrationRunId, 'run-1')
  assert.equal(remapped.orchestrationRole, 'reviewer')
  assert.deepEqual(remapped.builtInMcpDomains, ['orchestration'])
  assert.equal(remapped.providerSessionId, 'provider-child')
}

{
  const meta: SessionMeta = {
    cwd: '/repo',
    kind: 'claude',
    linkedParentId: 'missing-linked-parent',
    orchestrationParentId: 'missing-orchestration-parent',
    orchestrationRootId: 'missing-orchestration-root',
    orchestrationRunId: 'run-2',
  }

  const remapped = remapSessionMetaRelationships(meta, new Map())

  // WHY this assertion matters:
  // keeping a pre-restart parent/root id is worse than dropping the
  // relationship. Dispatch and orchestration MCP would treat that stale id as
  // an impossible live parent, so the restored child should become an ordinary
  // top-level row when the relationship endpoint failed to respawn.
  assert.equal(remapped.linkedParentId, undefined)
  assert.equal(remapped.orchestrationParentId, undefined)
  assert.equal(remapped.orchestrationRootId, undefined)
  assert.equal(remapped.orchestrationRunId, 'run-2')
}

{
  const meta: SessionMeta = {
    cwd: '/repo',
    kind: 'codex',
  }

  assert.deepEqual(
    remapSessionMetaRelationships(meta, new Map([['irrelevant-old', 'irrelevant-new']])),
    meta,
  )
}
