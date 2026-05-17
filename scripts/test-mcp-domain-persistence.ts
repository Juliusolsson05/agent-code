import {
  normalizeSessionBuiltInMcpDomains,
  withNormalizedBuiltInMcpDomains,
} from '../src/renderer/src/workspace/mcpDomains'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const normalized = normalizeSessionBuiltInMcpDomains([
  'orchestration',
  'unknown',
  'ping',
  'orchestration',
  42,
])
assert(
  JSON.stringify(normalized) === JSON.stringify(['orchestration', 'ping']),
  'normalizer should preserve allowed domains once and drop junk',
)

const empty = normalizeSessionBuiltInMcpDomains(['unknown'])
assert(empty === undefined, 'normalizer should omit empty domain lists')

const meta = withNormalizedBuiltInMcpDomains({
  cwd: '/tmp/project',
  kind: 'claude' as const,
  builtInMcpDomains: ['orchestration', 'orchestration'],
})
assert(
  JSON.stringify(meta.builtInMcpDomains) === JSON.stringify(['orchestration']),
  'metadata helper should normalize persisted session domains',
)
