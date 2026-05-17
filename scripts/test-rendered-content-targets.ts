import assert from 'node:assert/strict'

import {
  classifyRenderedTarget,
  normalizeAllowedExternalUrl,
  parsePathLineColumnSuffix,
} from '../src/shared/renderedContent/targets'

const root = '/Users/alice/project'

assert.equal(
  normalizeAllowedExternalUrl('https://example.com/path?q=1'),
  'https://example.com/path?q=1',
)
assert.equal(
  normalizeAllowedExternalUrl('http://example.com'),
  'http://example.com/',
)
assert.equal(normalizeAllowedExternalUrl('javascript:alert(1)'), null)
assert.equal(normalizeAllowedExternalUrl('file:///Users/alice/project/a.ts'), null)
assert.equal(normalizeAllowedExternalUrl('http://'), null)

assert.deepEqual(parsePathLineColumnSuffix('src/app.ts'), {
  path: 'src/app.ts',
  line: null,
  column: null,
})
assert.deepEqual(parsePathLineColumnSuffix('src/app.ts:42'), {
  path: 'src/app.ts',
  line: 42,
  column: null,
})
assert.deepEqual(parsePathLineColumnSuffix('src/app.ts:42:10'), {
  path: 'src/app.ts',
  line: 42,
  column: 10,
})
assert.deepEqual(parsePathLineColumnSuffix('src/app.ts:nope'), {
  path: 'src/app.ts:nope',
  line: null,
  column: null,
})

assert.deepEqual(classifyRenderedTarget('https://example.com', { workspaceRoot: root }), {
  kind: 'external-url',
  url: 'https://example.com/',
})
assert.deepEqual(classifyRenderedTarget('http://example.com/a', { workspaceRoot: root }), {
  kind: 'external-url',
  url: 'http://example.com/a',
})
assert.deepEqual(classifyRenderedTarget('http://', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'malformed-url',
})
assert.deepEqual(classifyRenderedTarget('javascript:alert(1)', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'unsafe-protocol',
})
assert.deepEqual(classifyRenderedTarget('data:text/html,hi', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'unsafe-protocol',
})
assert.deepEqual(classifyRenderedTarget('file:///Users/alice/project/src/app.ts', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'unsafe-protocol',
})
assert.deepEqual(classifyRenderedTarget('agent-code://open', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'unsafe-protocol',
})

assert.deepEqual(classifyRenderedTarget('src/app.ts', { workspaceRoot: root }), {
  kind: 'local-file',
  path: 'src/app.ts',
  line: null,
  column: null,
})
assert.deepEqual(classifyRenderedTarget('./src/app.ts:42', { workspaceRoot: root }), {
  kind: 'local-file',
  path: 'src/app.ts',
  line: 42,
  column: null,
})
assert.deepEqual(classifyRenderedTarget('src/app.ts:42:10', { workspaceRoot: root }), {
  kind: 'local-file',
  path: 'src/app.ts',
  line: 42,
  column: 10,
})
assert.deepEqual(classifyRenderedTarget('/Users/alice/project/src/app.ts:3', { workspaceRoot: root }), {
  kind: 'local-file',
  path: 'src/app.ts',
  line: 3,
  column: null,
})
assert.deepEqual(classifyRenderedTarget('/Users/alice/other/src/app.ts', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'outside-workspace',
})
assert.deepEqual(classifyRenderedTarget('../outside.ts', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'not-a-file-path',
})
assert.deepEqual(classifyRenderedTarget('src/../secret.ts', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'not-a-file-path',
})
assert.deepEqual(classifyRenderedTarget('README.md:5', { workspaceRoot: null }), {
  kind: 'unsupported',
  reason: 'missing-workspace-root',
})
assert.deepEqual(classifyRenderedTarget('not a path', { workspaceRoot: root }), {
  kind: 'unsupported',
  reason: 'not-a-file-path',
})

// Missing files are intentionally not rejected by the pure classifier because
// existence is the main-process editor-fs boundary's job. This keeps renderer
// parsing deterministic while still making the real click path fail safely.
assert.deepEqual(classifyRenderedTarget('src/missing.ts', { workspaceRoot: root }), {
  kind: 'local-file',
  path: 'src/missing.ts',
  line: null,
  column: null,
})

console.log('rendered content target classification ok')
