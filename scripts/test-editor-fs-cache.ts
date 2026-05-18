import assert from 'node:assert/strict'

import { EditorFsCache } from '../src/main/ipc/editorFsCache'

let now = 1_000
const cache = new EditorFsCache({
  ttlMs: 100,
  maxDirectories: 2,
  maxFiles: 2,
  maxFileBytes: 10,
  now: () => now,
})

cache.setDirectory({
  root: '/repo',
  path: 'src',
  showHidden: false,
  mtimeMs: 10,
  size: 64,
  entries: [{ name: 'a.ts', path: 'src/a.ts', isDirectory: false, size: null, mtimeMs: 0 }],
})

const firstDirectory = cache.getDirectory({
  root: '/repo',
  path: 'src',
  showHidden: false,
  mtimeMs: 10,
  size: 64,
})
assert.equal(firstDirectory?.[0]?.path, 'src/a.ts')
if (firstDirectory) firstDirectory[0].name = 'mutated.ts'
assert.equal(
  cache.getDirectory({ root: '/repo', path: 'src', showHidden: false, mtimeMs: 10, size: 64 })?.[0]?.name,
  'a.ts',
)
assert.equal(
  cache.getDirectory({ root: '/repo', path: 'src', showHidden: true, mtimeMs: 10, size: 64 }),
  null,
)
assert.equal(
  cache.getDirectory({ root: '/repo', path: 'src', showHidden: false, mtimeMs: 11, size: 64 }),
  null,
)

cache.setTextFile({
  root: '/repo',
  path: 'src/a.ts',
  read: { path: 'src/a.ts', text: 'alpha', mtimeMs: 20, size: 5 },
})
assert.equal(
  cache.getTextFile({ root: '/repo', path: 'src/a.ts', mtimeMs: 20, size: 5 })?.text,
  'alpha',
)
cache.setTextFile({
  root: '/repo',
  path: 'src/big.ts',
  read: { path: 'src/big.ts', text: '01234567890', mtimeMs: 20, size: 11 },
})
assert.equal(cache.getTextFile({ root: '/repo', path: 'src/big.ts', mtimeMs: 20, size: 11 }), null)

cache.setDirectory({
  root: '/repo',
  path: 'src',
  showHidden: false,
  mtimeMs: 10,
  size: 64,
  entries: [{ name: 'a.ts', path: 'src/a.ts', isDirectory: false, size: null, mtimeMs: 0 }],
})
cache.invalidatePath('/repo', 'src/a.ts')
assert.equal(cache.getTextFile({ root: '/repo', path: 'src/a.ts', mtimeMs: 20, size: 5 }), null)
assert.equal(cache.getDirectory({ root: '/repo', path: 'src', showHidden: false, mtimeMs: 10, size: 64 }), null)

cache.setTextFile({
  root: '/repo',
  path: 'src/ttl.ts',
  read: { path: 'src/ttl.ts', text: 'ttl', mtimeMs: 30, size: 3 },
})
now += 101
assert.equal(cache.getTextFile({ root: '/repo', path: 'src/ttl.ts', mtimeMs: 30, size: 3 }), null)

