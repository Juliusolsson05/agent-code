import { describe, expect, it } from 'vitest'

import { EXTENSION_CAPABILITIES } from '@shared/types/extensions.js'
import { CUSTOM_APPEARANCE_COLOR_KEYS } from '@shared/appearanceColors.js'
import { EXTENSION_THEME_COLOR_KEYS } from '../../../packages/agent-code-extension-api/dist/themes.js'
import {
  ManifestError,
  SUPPORTED_API_VERSION,
  apiVersionMismatch,
  parseExtensionManifest,
} from '@main/extensions/manifest.js'

// The manifest is the least-trusted input in the application: JSON from a
// repository whose name a user pasted, which then decides a directory name, a
// module URL the renderer executes, a set of global command ids, and a
// permission prompt. Everything here protects a rule that, if it stopped
// holding, would be invisible until something hostile or badly-built arrived.

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'timer',
    name: 'Timer',
    description: 'A focus timer.',
    version: '0.1.0',
    apiVersion: 1,
    entry: 'dist/index.js',
    ...overrides,
  })
}

describe('declarative theme manifest boundary', () => {
  const theme = { id: 'timer.night', title: 'Timer Night', colors: { canvas: '#123456', overlayScrim: '#1234', ink: '#abcdef90', accent: '#abc', rowBg: 'transparent' } }
  it('retains literal colors as metadata with no activation or permission', () => {
    const parsed = parseExtensionManifest(manifest({ contributes: { themes: [theme] } }))
    expect(parsed.contributes?.themes).toEqual([theme])
    expect(parsed.activationEvents).toBeUndefined()
    expect(parsed.permissions).toBeUndefined()
  })
  it.each([
    ['another namespace', { ...theme, id: 'other.night' }],
    ['host mode id', { ...theme, id: 'dark' }],
    ['empty title', { ...theme, title: '   ' }],
    ['unknown token', { ...theme, colors: { font: '#123456' } }],
    ['empty palette', { ...theme, colors: {} }],
    ['URL', { ...theme, colors: { canvas: 'url(https://example.test/track)' } }],
    ['escaped URL', { ...theme, colors: { canvas: 'rgb(0 0 0) u\\72l(https://example.test)' } }],
    ['variable', { ...theme, colors: { canvas: 'var(--secret)' } }],
    ['declaration', { ...theme, colors: { canvas: '#123; display:none' } }],
    ['malformed hex length', { ...theme, colors: { canvas: '#12345' } }],
  ])('rejects %s before publication', (_label, invalid) => {
    expect(() => parseExtensionManifest(manifest({ contributes: { themes: [invalid] } }))).toThrow(ManifestError)
  })
  it('rejects duplicate themes and bounds contribution count', () => {
    expect(() => parseExtensionManifest(manifest({ contributes: { themes: [theme, theme] } }))).toThrow(/duplicate theme/)
    const themes = Array.from({ length: 17 }, (_, index) => ({ ...theme, id: `timer.theme${index}` }))
    expect(() => parseExtensionManifest(manifest({ contributes: { themes } }))).toThrow(ManifestError)
  })
  it('accepts every appearance token authors can style', () => {
    expect(EXTENSION_THEME_COLOR_KEYS).toEqual(CUSTOM_APPEARANCE_COLOR_KEYS)
    const colors = Object.fromEntries(CUSTOM_APPEARANCE_COLOR_KEYS.map(key => [key, '#123456']))
    expect(parseExtensionManifest(manifest({ contributes: { themes: [{ ...theme, colors }] } })).contributes?.themes?.[0]?.colors).toEqual(colors)
  })
})

describe('parseExtensionManifest — path safety of `entry`', () => {
  // `entry` is joined onto the bundle directory and then loaded AS CODE over a
  // scheme the renderer is allowed to execute from. Each of these shapes turns
  // that field into arbitrary-file access if the refinement is lost.
  it.each([
    ['absolute', '/etc/passwd.js'],
    ['parent traversal', '../../../etc/passwd.js'],
    ['traversal mid-path', 'dist/../../secrets.js'],
    ['backslash separator', 'dist\\index.js'],
    ['not a module', 'dist/index.txt'],
  ])('rejects an %s entry', (_label, entry) => {
    expect(() => parseExtensionManifest(manifest({ entry }))).toThrow(ManifestError)
  })

  it('accepts an ordinary nested module path', () => {
    expect(parseExtensionManifest(manifest({ entry: 'dist/index.js' })).entry).toBe('dist/index.js')
  })
})

describe('parseExtensionManifest — id grammar', () => {
  // The id becomes a directory name under EXTENSIONS_DIR, the storage namespace,
  // and the HOST of the extension's own origin. A value that escapes any of
  // those is a path-traversal primitive.
  it.each([
    ['traversal', '../evil'],
    ['slash', 'a/b'],
    ['leading digit', '1timer'],
    ['uppercase', 'Timer'],
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
  ])('rejects a %s id', (_label, id) => {
    expect(() => parseExtensionManifest(manifest({ id }))).toThrow(ManifestError)
  })
})

describe('parseExtensionManifest — contribution namespacing', () => {
  it('rejects a command id outside the extension namespace', () => {
    // Contributed ids land in one registry beside ~95 first-party commands.
    // `session.kill` from a third party would collide with a real command and
    // resolve arbitrarily; install is the last moment a user can act on it.
    expect(() =>
      parseExtensionManifest(
        manifest({ contributes: { commands: [{ id: 'session.kill', title: 'Kill' }] } }),
      ),
    ).toThrow(/must start with "timer\."/)
  })

  it('rejects a keybinding pointing at a command it does not contribute', () => {
    expect(() =>
      parseExtensionManifest(
        manifest({
          contributes: {
            commands: [{ id: 'timer.start', title: 'Start' }],
            keybindings: [{ command: 'timer.nope', key: 'cmd+t' }],
          },
        }),
      ),
    ).toThrow(/does not contribute/)
  })

  it.each(['a', 'Enter', 'shift+k', 'ctrl+r', 'alt+j'])('rejects a keybinding without Cmd (%s)', key => {
    // Contributed chords are consulted app-wide, including while the user types
    // in a composer or terminal, so a chord without Cmd would swallow typing.
    expect(() =>
      parseExtensionManifest(
        manifest({
          contributes: {
            commands: [{ id: 'timer.start', title: 'Start' }],
            keybindings: [{ command: 'timer.start', key }],
          },
        }),
      ),
    ).toThrow(/must be a single chord that includes Cmd/)
  })

  it('rejects an activation event naming a contribution that does not exist', () => {
    // A dead activation event is the hardest authoring mistake to diagnose: the
    // extension simply never activates, with no error anywhere.
    expect(() =>
      parseExtensionManifest(
        manifest({
          activationEvents: ['onCommand:timer.ghost'],
          contributes: { commands: [{ id: 'timer.start', title: 'Start' }] },
        }),
      ),
    ).toThrow(/does not contribute/)
  })

  it('rejects duplicate ids within one manifest', () => {
    expect(() =>
      parseExtensionManifest(
        manifest({
          contributes: {
            commands: [
              { id: 'timer.start', title: 'Start' },
              { id: 'timer.start', title: 'Start again' },
            ],
          },
        }),
      ),
    ).toThrow(/duplicate command id/)
  })
})

describe('parseExtensionManifest — capabilities', () => {
  it('accepts every capability the host actually implements', () => {
    // net.origins is only coherent with its declared list (see below).
    const parsed = parseExtensionManifest(manifest({ apiVersion: 2, permissions: [...EXTENSION_CAPABILITIES], networkOrigins: ['https://api.example.com'] }))
    expect(parsed.permissions).toEqual([...EXTENSION_CAPABILITIES])
  })

  it.each(['fs.read', 'fs.write', 'notifications.show'])('keeps %s on the v2 service contract', permission => {
    expect(() => parseExtensionManifest(manifest({ permissions: [permission] }))).toThrow(/requires Agent Code API v2/)
  })

  // ── THE REGRESSION THIS BLOCK EXISTS FOR ──
  // The schema used to accept seven Tier 2/3 names that nothing implemented:
  // there was no frameProtocol request member, no frameHost arm, no API surface.
  // A manifest could ask for filesystem write and git commit, the user got a
  // blocking OS warning dialog naming those powers, approved it, and a permanent
  // grant was written for capabilities that did nothing. Refusing the install is
  // the honest outcome — it tells the author their extension needs a newer host
  // instead of silently granting them nothing.
  it.each(['git.read', 'git.commit', 'transcript.read', 'sessions.prompt', 'network.fetch'])(
    'refuses to install a manifest requesting the unimplemented capability %s',
    capability => {
      expect(() => parseExtensionManifest(manifest({ permissions: [capability] }))).toThrow(
        ManifestError,
      )
    },
  )

  it('names the accepted set in the failure message rather than reading as a typo report', () => {
    expect(() => parseExtensionManifest(manifest({ permissions: ['git.read'] }))).toThrow(
      /not available yet/,
    )
  })
})

describe('apiVersionMismatch', () => {
  // Extracted from parseExtensionManifest precisely so the ledger can apply it on
  // every read. Version skew arrives by UPGRADING AGENT CODE, which involves no
  // install, so an install-time-only check can never observe it.
  it('passes the supported version', () => {
    expect(apiVersionMismatch(SUPPORTED_API_VERSION)).toBeNull()
  })

  it('reports both versions so the message says who is out of date', () => {
    const message = apiVersionMismatch(SUPPORTED_API_VERSION + 1)
    expect(message).toContain(`v${SUPPORTED_API_VERSION + 1}`)
    expect(message).toContain(`v${SUPPORTED_API_VERSION}`)
  })

  it('keeps the explicit v1 adapter and rejects unsupported old versions', () => {
    // A downgrade is just as much a contract mismatch: the host would hand a v1
    // object to code written against v0's shape.
    expect(apiVersionMismatch(1)).toBeNull()
    expect(apiVersionMismatch(0)).not.toBeNull()
  })
})

it('requires a separately contained view module for API v2 while retaining v1 manifests', () => {
  const view = { id: 'timer.main', title: 'Timer', mount: 'panel' }
  expect(() => parseExtensionManifest(manifest({ apiVersion: 2, contributes: { views: [view] } }))).toThrow('separate mount module')
  expect(() => parseExtensionManifest(manifest({ apiVersion: 2, contributes: { views: [{ ...view, entry: '../escape.js' }] } }))).toThrow('..')
  const parsed = parseExtensionManifest(manifest({ apiVersion: 2, contributes: { views: [{ ...view, entry: 'dist/view.js' }] } }))
  expect(parsed.contributes?.views?.[0]?.entry).toBe('dist/view.js')
  expect(parseExtensionManifest(manifest({ contributes: { views: [view] } })).apiVersion).toBe(1)
})

describe('contributes.services', () => {
  const service = { id: 'timer.worker', entry: 'dist/worker.js' }
  const v2 = { apiVersion: 2, entry: 'dist/index.js' }

  it('accepts a declared v2 service and keeps the closed capability in lockstep', () => {
    const parsed = parseExtensionManifest(manifest({ ...v2, contributes: { services: [service] }, permissions: ['service.run'] }))
    expect(parsed.contributes?.services).toEqual([service])
    // The union is load-bearing in both directions: a name in the schema that
    // EXTENSION_CAPABILITIES does not know fails every future install.
    expect(EXTENSION_CAPABILITIES).toContain('service.run')
  })

  it.each([
    ['v1 manifest', { contributes: { services: [service] } }, /API v2/],
    ['v1 permission', { apiVersion: 1, permissions: ['service.run'] }, /API v2/],
    ['missing entry', { ...v2, contributes: { services: [{ id: 'timer.worker' }] } }, /entry/],
    ['escaping entry', { ...v2, contributes: { services: [{ ...service, entry: '../../tool.js' }] } }, /..|entry/i],
    ['foreign namespace', { ...v2, contributes: { services: [{ ...service, id: 'other.worker' }] } }, /namespace/],
    ['duplicate ids', { ...v2, contributes: { services: [service, service] } }, /duplicate service/],
    ['too many services', { ...v2, contributes: { services: Array.from({ length: 5 }, (_, i) => ({ id: `timer.s${i}`, entry: 'dist/s.js' })) } }, /services/],
  ])('rejects %s before publication', (_label, overrides, pattern) => {
    expect(() => parseExtensionManifest(manifest(overrides))).toThrow(pattern)
  })
})

describe('networkOrigins / net.origins (#1150)', () => {
  const v2 = (overrides: Record<string, unknown>) => manifest({ apiVersion: 2, permissions: ['net.origins'], ...overrides })

  it('accepts exact public https origins and keeps them verbatim for the consent dialog', () => {
    const parsed = parseExtensionManifest(v2({ networkOrigins: ['https://api.example.org', 'https://api.example.com:8443'] }))
    expect(parsed.networkOrigins).toEqual(['https://api.example.org', 'https://api.example.com:8443'])
  })

  // Each shape is a way for the dialog to under-state what can be reached.
  it.each([
    ['a wildcard subdomain', 'https://*.example.org'],
    ['plain http', 'http://api.example.org'],
    ['a path', 'https://api.example.org/v1'],
    ['a trailing slash', 'https://api.example.org/'],
    ['a query', 'https://api.example.org?x=1'],
    ['userinfo', 'https://user:pass@api.example.org'],
    ['an IPv4 literal', 'https://8.8.8.8'],
    ['an IPv6 literal', 'https://[2001:db8::1]'],
    ['localhost', 'https://localhost'],
    ['an mDNS name', 'https://printer.local'],
    ['a single-label name', 'https://intranet'],
    ['a non-URL', 'api.example.org'],
    ['upper-case host (not the canonical origin)', 'https://API.example.org'],
    // WHATWG keeps a trailing dot as written, so each of these used to pass
    // the suffix checks (the first two resolve to this machine / the LAN).
    ['a trailing-dot localhost', 'https://localhost.'],
    ['a trailing-dot mDNS name', 'https://foo.local.'],
    ['a trailing-dot public name', 'https://api.example.com.'],
  ])('refuses %s', (_label, origin) => {
    expect(() => parseExtensionManifest(v2({ networkOrigins: [origin] }))).toThrow(ManifestError)
    // Pin that the URL parser really kept the dot (the case the check exists for).
    if (origin.endsWith('.')) expect(new URL(origin).origin).toBe(origin)
  })

  it('pairs the list with the permission in both directions', () => {
    expect(() => parseExtensionManifest(v2({}))).toThrow(/requires a "networkOrigins" list/)
    expect(() => parseExtensionManifest(manifest({ apiVersion: 2, networkOrigins: ['https://api.example.com'] })))
      .toThrow(/requires the "net.origins" permission/)
  })

  it('is v2-only, bounded and duplicate-free', () => {
    expect(() => parseExtensionManifest(manifest({ permissions: ['net.origins'], networkOrigins: ['https://api.example.com'] })))
      .toThrow(/API v2/)
    expect(() => parseExtensionManifest(v2({ networkOrigins: Array.from({ length: 5 }, (_, i) => `https://a${i}.example.com`) })))
      .toThrow(ManifestError)
    expect(() => parseExtensionManifest(v2({ networkOrigins: ['https://api.example.com', 'https://api.example.com'] })))
      .toThrow(/duplicate network origin/)
  })
})
