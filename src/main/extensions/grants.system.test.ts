import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// STATE_DIR is resolved at module load from homedir(), so the grant store's file
// location is fixed before any test can influence it. Mocking the paths module is
// the narrowest seam that keeps these tests off the developer's real
// ~/.config/agent-code — which they must be, because they write grants.
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-code-grants-'))
vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateRoot,
  EXTENSIONS_DIR: join(stateRoot, 'extensions'),
  EXTENSIONS_LOCKFILE: join(stateRoot, 'extensions.json'),
  EXTENSION_STATE_DIR: join(stateRoot, 'extension-state'),
}))

const { grantedCapabilities, recordGrant, revokeGrant } = await import(
  '@main/extensions/grants.js'
)

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

afterEach(async () => {
  await rm(join(stateRoot, 'extension-grants.json'), { force: true })
})

describe('grant binding', () => {
  it('returns the granted capabilities for the hash they were approved at', async () => {
    await recordGrant('timer', HASH_A, ['workspace.observe', 'sessions.observe'])
    const granted = await grantedCapabilities('timer', HASH_A)
    expect([...granted].sort()).toEqual(['sessions.observe', 'workspace.observe'])
  })

  // ── THE REGRESSION THIS FILE EXISTS FOR ──
  // The grant used to be checked against a hash READ BACK OUT OF THE LEDGER, which
  // the same install had just written — so the comparison compared two copies of
  // one value and could never fail. The documented rule ("different bytes, no
  // grant") did not exist. This is that rule, stated as a test.
  it('returns NOTHING for a different hash', async () => {
    await recordGrant('timer', HASH_A, ['workspace.observe'])
    expect([...(await grantedCapabilities('timer', HASH_B))]).toEqual([])
  })

  it('returns nothing for an extension that was never granted anything', async () => {
    expect([...(await grantedCapabilities('never-installed', HASH_A))]).toEqual([])
  })

  it('replaces the previous grant rather than accumulating', async () => {
    // An update that asks for fewer capabilities must not inherit the old set.
    await recordGrant('timer', HASH_A, ['workspace.observe', 'sessions.observe'])
    await recordGrant('timer', HASH_B, ['workspace.observe'])
    expect([...(await grantedCapabilities('timer', HASH_B))]).toEqual(['workspace.observe'])
    // And the superseded hash grants nothing at all.
    expect([...(await grantedCapabilities('timer', HASH_A))]).toEqual([])
  })

  it('revokes', async () => {
    await recordGrant('timer', HASH_A, ['workspace.observe'])
    await revokeGrant('timer')
    expect([...(await grantedCapabilities('timer', HASH_A))]).toEqual([])
  })

  it('keeps other extensions untouched when one is revoked', async () => {
    await recordGrant('timer', HASH_A, ['workspace.observe'])
    await recordGrant('notes', HASH_A, ['panes.observe'])
    await revokeGrant('timer')
    expect([...(await grantedCapabilities('notes', HASH_A))]).toEqual(['panes.observe'])
  })
})

describe('grant store hostile-file handling', () => {
  async function writeGrantsFile(contents: string): Promise<void> {
    await mkdir(stateRoot, { recursive: true })
    await writeFile(join(stateRoot, 'extension-grants.json'), contents, 'utf8')
  }

  it('drops a capability the host does not implement', async () => {
    // The seven Tier 2/3 capabilities were removed from the manifest schema. A
    // grants file written by an older build still names them, and the store used to
    // parse capabilities as `z.array(z.string())` — carrying them forward verbatim
    // into the Set that frameHost checks against. Parsing against the real enum
    // makes the migration automatic and means the store cannot hold an authorisation
    // for a power that does not exist.
    await writeGrantsFile(
      JSON.stringify([
        {
          extensionId: 'timer',
          sha256: HASH_A,
          capabilities: ['workspace.observe', 'fs.write', 'network.fetch'],
          grantedAt: 1,
        },
      ]),
    )
    expect([...(await grantedCapabilities('timer', HASH_A))]).toEqual(['workspace.observe'])
  })

  it('survives a corrupt file rather than throwing', async () => {
    // A throw here would propagate into the capability check, and the check's
    // callers treat a throw as an error rather than as "no capabilities". Degrading
    // to an empty store is both fail-closed and recoverable.
    await writeGrantsFile('{ not json at all')
    expect([...(await grantedCapabilities('timer', HASH_A))]).toEqual([])
  })

  it('drops a malformed row without discarding valid siblings', async () => {
    await writeGrantsFile(
      JSON.stringify([
        { extensionId: 'broken', sha256: 'not-a-hash', capabilities: [], grantedAt: 1 },
        { extensionId: 'timer', sha256: HASH_A, capabilities: ['panes.observe'], grantedAt: 2 },
      ]),
    )
    expect([...(await grantedCapabilities('timer', HASH_A))]).toEqual(['panes.observe'])
    expect([...(await grantedCapabilities('broken', HASH_A))]).toEqual([])
  })
})
