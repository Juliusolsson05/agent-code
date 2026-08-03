import { z } from 'zod'

import type {
  ExtensionActivationEvent,
  ExtensionManifest,
} from '@shared/types/extensions.js'

// Manifest validation.
//
// WHY zod and not hand-written checks: this JSON comes from a repository the user
// pasted a name for. It is the least trusted input in the app. The remote protocol
// (main/remote/protocol/messages.ts) already established the principle here — the
// schema IS the allow-list, and anything not expressible in it is unrepresentable
// rather than denied later. Same reasoning, same library, already a dependency.

/** The one AgentCodeApi major this host implements. */
export const SUPPORTED_API_VERSION = 1

// Duplicated from main/extensions/storage.ts on purpose, with the duplication
// called out in both places: storage owns the rule because there the id becomes a
// filesystem path, and this schema owns it because here is where a hostile manifest
// first arrives. A single shared const would be tidier but would let a future edit
// to one call site silently relax the other's guarantee.
const EXTENSION_ID = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'id must match /^[a-z][a-z0-9-]{0,63}$/')

// WHY `entry` is this restrictive: it is joined onto the bundle directory and then
// loaded as code. `../../../etc/passwd`, an absolute path, or a URL would each turn
// a manifest field into arbitrary-file access. Rejecting the shape here means the
// containment check in install.ts is a second line of defence rather than the only
// one. Backslashes are rejected too — a Windows-style separator that survives to a
// POSIX join is a normalization bug waiting to happen.
const ENTRY_PATH = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !value.startsWith('/'), 'entry must be a relative path')
  .refine(value => !value.includes('\\'), 'entry must use forward slashes')
  .refine(
    value => !value.split('/').some(segment => segment === '..'),
    'entry must not contain ".." segments',
  )
  .refine(value => /\.m?js$/.test(value), 'entry must be a .js or .mjs module')

// Contribution ids are `<extensionId>.<name>`, optionally with further dotted
// segments (`timer.ui.accent`). The namespace half is checked against the
// manifest's own id after parsing, where the id is available.
//
// WHY camelCase is allowed after the first dot while the extension id itself is
// kebab-only: the extension id becomes a DIRECTORY NAME, so it is constrained by
// the filesystem and by case-insensitive volumes. A contribution id is just a
// registry key, and `timer.inheritTheme` is the idiomatic spelling everywhere
// this convention exists. An earlier version of this regex demanded kebab-case
// throughout and rejected the first real manifest written against it.
const CONTRIBUTION_ID = z
  .string()
  .min(3)
  .max(96)
  .regex(
    /^[a-z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/,
    'must look like "<extensionId>.<name>"',
  )

const commandContribution = z.object({
  id: CONTRIBUTION_ID,
  title: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  keywords: z.array(z.string().min(1).max(40)).max(24).optional(),
})

const viewContribution = z.object({
  id: CONTRIBUTION_ID,
  title: z.string().min(1).max(80),
  // Closed union rather than a free string: the host owns the chrome, and an
  // unknown mount kind must fail at install with a message rather than resolve
  // to nothing at render time. 'panel'/'tab' get added here when their host
  // shells exist.
  mount: z.enum(['modal', 'panel']),
})

const settingContribution = z.discriminatedUnion('type', [
  z.object({
    id: CONTRIBUTION_ID,
    title: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    type: z.literal('boolean'),
    default: z.boolean(),
  }),
  z.object({
    id: CONTRIBUTION_ID,
    title: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    type: z.literal('number'),
    // Finite only — a NaN default would be written straight into extension
    // storage, where JSON.stringify turns it into null.
    default: z.number().finite(),
  }),
  z.object({
    id: CONTRIBUTION_ID,
    title: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    type: z.literal('string'),
    default: z.string().max(400),
  }),
])

const keybindingContribution = z.object({
  command: CONTRIBUTION_ID,
  key: z.string().min(1).max(64),
})

// A closed capability set — like activationEvent, an unknown capability must fail
// install with a message, not resolve to nothing. Kept in lockstep with
// EXTENSION_CAPABILITIES in @shared/types/extensions (the schema wins on drift).
const capabilityName = z.enum([
  'workspace.observe',
  'sessions.observe',
  'panes.observe',
  'fs.read',
  'transcript.read',
  'git.read',
  'sessions.prompt',
  'fs.write',
  'git.commit',
  'network.fetch',
])

// `.refine` validates but does not narrow, so the parsed type would be `string`
// and would not satisfy ExtensionActivationEvent. The transform is the narrowing
// step, and it is safe precisely because the refine above already rejected
// everything outside the union — if that predicate and this cast ever disagree,
// the predicate is the bug.
const activationEvent = z
  .string()
  .max(96)
  .refine(
    value =>
      value === 'onStartupFinished' ||
      value === '*' ||
      value.startsWith('onCommand:') ||
      value.startsWith('onView:'),
    'unknown activation event',
  )
  .transform(value => value as ExtensionActivationEvent)

export const extensionManifestSchema = z.object({
  id: EXTENSION_ID,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  version: z.string().min(1).max(40),
  apiVersion: z.number().int().positive(),
  entry: ENTRY_PATH,
  keywords: z.array(z.string().min(1).max(40)).max(24).optional(),
  activationEvents: z.array(activationEvent).max(32).optional(),
  contributes: z
    .object({
      commands: z.array(commandContribution).max(64).optional(),
      views: z.array(viewContribution).max(16).optional(),
      settings: z.array(settingContribution).max(64).optional(),
      keybindings: z.array(keybindingContribution).max(32).optional(),
    })
    .optional(),
  permissions: z.array(capabilityName).max(16).optional(),
})

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/**
 * Parse and validate a manifest's raw text.
 *
 * Throws ManifestError with a message intended to be shown to the user — they are
 * the one who chose the repository, so "this repo's manifest is missing `entry`" is
 * actionable to them in a way a stack trace is not.
 */
export function parseExtensionManifest(raw: string): ExtensionManifest {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ManifestError('agent-code.extension.json is not valid JSON')
  }

  const result = extensionManifestSchema.safeParse(json)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ManifestError(`agent-code.extension.json is invalid — ${detail}`)
  }

  // Checked after shape validation rather than inside the schema so the user gets
  // "needs API v2, this build has v1" instead of a generic field error. This is the
  // only failure here that is not the author's mistake — it means Agent Code is out
  // of date relative to the extension, and the message should say so.
  if (result.data.apiVersion !== SUPPORTED_API_VERSION) {
    throw new ManifestError(
      `extension targets Agent Code API v${result.data.apiVersion}, this build implements v${SUPPORTED_API_VERSION}`,
    )
  }

  assertContributionsAreCoherent(result.data)
  return result.data
}

/**
 * Cross-field checks the schema cannot express, because each needs the
 * manifest's own `id` or a view of the whole `contributes` block.
 */
function assertContributionsAreCoherent(manifest: ExtensionManifest): void {
  const prefix = `${manifest.id}.`
  const commands = manifest.contributes?.commands ?? []
  const views = manifest.contributes?.views ?? []
  const settings = manifest.contributes?.settings ?? []
  const keybindings = manifest.contributes?.keybindings ?? []

  // WHY namespacing is ENFORCED and not merely conventional: contributed command
  // ids land in one global registry beside ~95 first-party commands. An
  // extension declaring `session.kill` would collide with a real one, and the
  // resolution would be arbitrary. Install is the only moment where the user can
  // still act on it, so it fails here rather than resolving oddly forever.
  const namespaced = [...commands, ...views, ...settings]
  for (const contribution of namespaced) {
    if (!contribution.id.startsWith(prefix)) {
      throw new ManifestError(
        `contribution id "${contribution.id}" must start with "${prefix}" — ` +
          `extensions may only contribute inside their own namespace`,
      )
    }
  }

  // Duplicates WITHIN one manifest are always an authoring mistake and are
  // rejected. Duplicates ACROSS extensions are a different problem — they are
  // resolved at load time (first wins, second reported) because neither author
  // can see the other's manifest and failing the install would punish whoever
  // happened to install second.
  assertUnique(commands.map(c => c.id), 'command')
  assertUnique(views.map(v => v.id), 'view')
  assertUnique(settings.map(s => s.id), 'setting')

  const commandIds = new Set(commands.map(command => command.id))
  for (const binding of keybindings) {
    if (!commandIds.has(binding.command)) {
      throw new ManifestError(
        `keybinding "${binding.key}" targets command "${binding.command}", ` +
          `which this extension does not contribute`,
      )
    }
  }

  // An activation event naming a contribution that does not exist is silently
  // dead — the extension would simply never activate, with no error anywhere.
  // That is the single hardest authoring mistake to diagnose, so it is rejected.
  const viewIds = new Set(views.map(view => view.id))
  for (const event of manifest.activationEvents ?? []) {
    if (event.startsWith('onCommand:')) {
      const target = event.slice('onCommand:'.length)
      if (!commandIds.has(target)) {
        throw new ManifestError(
          `activation event "${event}" names a command this extension does not contribute`,
        )
      }
    } else if (event.startsWith('onView:')) {
      const target = event.slice('onView:'.length)
      if (!viewIds.has(target)) {
        throw new ManifestError(
          `activation event "${event}" names a view this extension does not contribute`,
        )
      }
    }
  }
}

function assertUnique(ids: string[], kind: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new ManifestError(`duplicate ${kind} id "${id}"`)
    seen.add(id)
  }
}
