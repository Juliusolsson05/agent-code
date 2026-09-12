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
    const parsed = parseExtensionManifest(manifest({ apiVersion: 2, permissions: [...EXTENSION_CAPABILITIES] }))
    expect(parsed.permissions).toEqual([...EXTENSION_CAPABILITIES])
  })

  it('keeps filesystem reads on the v2 service contract', () => {
    expect(() => parseExtensionManifest(manifest({ permissions: ['fs.read'] }))).toThrow(/requires Agent Code API v2/)
  })

  // ── THE REGRESSION THIS BLOCK EXISTS FOR ──
  // The schema used to accept seven Tier 2/3 names that nothing implemented:
  // there was no frameProtocol request member, no frameHost arm, no API surface.
  // A manifest could ask for filesystem write and git commit, the user got a
  // blocking OS warning dialog naming those powers, approved it, and a permanent
  // grant was written for capabilities that did nothing. Refusing the install is
  // the honest outcome — it tells the author their extension needs a newer host
  // instead of silently granting them nothing.
  it.each(['fs.write', 'git.read', 'git.commit', 'transcript.read', 'sessions.prompt', 'network.fetch'])(
    'refuses to install a manifest requesting the unimplemented capability %s',
    capability => {
      expect(() => parseExtensionManifest(manifest({ permissions: [capability] }))).toThrow(
        ManifestError,
      )
    },
  )

  it('names the accepted set in the failure message rather than reading as a typo report', () => {
    expect(() => parseExtensionManifest(manifest({ permissions: ['fs.write'] }))).toThrow(
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
