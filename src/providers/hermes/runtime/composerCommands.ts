// Hermes' slash commands for the composer picker (#1497).
//
// Source of truth: Hermes' own `commands.catalog` for the session (built-ins,
// the user's quick commands, plugin commands and skills), so a skill or quick
// command the owner adds on the server appears here with no app change.
// Agent Code adds what Hermes cannot run over the WebSocket and refuses what
// needs a surface it does not have.

import type { CommandsCatalogResult } from 'hermes-headless'

import type { ComposerCommand, ComposerCommandAvailability } from '@shared/composerCommands/types.js'

/**
 * Commands Agent Code itself handles for a Hermes pane.
 *
 * `/restart` is `gateway_only` in Hermes (hermes_cli/commands.py: "Gracefully
 * restart the gateway after draining active runs"); `commands.catalog` leaves
 * it out and `slash.exec` cannot run it. The owner uses it from Telegram, so
 * Agent Code runs the dashboard's equivalent, `POST /api/gateway/restart`.
 */
export const HERMES_APP_COMMANDS: ComposerCommand[] = [
  {
    name: 'restart',
    aliases: [],
    description: 'Restart the Hermes messaging gateway (Telegram goes offline for about a minute)',
    category: 'Session',
    subcommands: [],
    source: 'app',
    availability: { kind: 'offered' },
  },
]

/**
 * Commands Hermes offers that need a picker or surface Agent Code does not
 * have yet (Hermes Desktop routes them to its own pickers/actions,
 * desktop-slash-commands.ts). Listed, so the user learns they exist, and
 * refused with a sentence instead of reaching `slash.exec`, where they would
 * print nothing useful or act on the worker's copy of the session.
 */
const APP_REFUSED: Record<string, string> = {
  model: '/model isn’t available in Agent Code yet. Change the model in Telegram or the Hermes dashboard.',
  resume: '/resume isn’t available in Agent Code yet. Open an earlier conversation from the Hermes dashboard.',
  handoff: '/handoff isn’t available in Agent Code: it would end your current Telegram conversation.',
  profile: '/profile isn’t available in Agent Code yet.',
  branch: '/branch isn’t available in Agent Code yet.',
  yolo: '/yolo isn’t available in Agent Code; approve commands from the card instead.',
  reasoning: '/reasoning isn’t available in Agent Code yet.',
}

/** Hermes' own availability reasons (CommandDef.desktop), in Agent Code's words. */
function unavailableSentence(name: string, reason: string): string {
  switch (reason) {
    case 'terminal': return `/${name} only runs in Hermes’ terminal app.`
    case 'messaging': return `/${name} only runs in a messaging app such as Telegram.`
    case 'settings': return `/${name} is a Hermes setting; change it in the Hermes dashboard.`
    case 'composer-voice': return `/${name} is for Hermes voice input.`
    case 'advanced': return `/${name} is an advanced Hermes command; run it from Hermes’ terminal app.`
    default: return `/${name} isn’t available in Agent Code.`
  }
}

function availabilityOf(name: string, desktop: string | null | undefined): ComposerCommandAvailability {
  const refused = APP_REFUSED[name]
  if (refused) return { kind: 'unavailable', reason: refused }
  if (desktop === null || desktop === undefined) return { kind: 'offered' }
  if (desktop === 'hidden') return { kind: 'hidden' }
  return { kind: 'unavailable', reason: unavailableSentence(name, desktop) }
}

export function composerCommandsFromCatalog(catalog: CommandsCatalogResult): ComposerCommand[] {
  const out = new Map<string, ComposerCommand>()
  const aliasesOf = new Map<string, string[]>()
  for (const [alias, canonical] of Object.entries(catalog.canon ?? {})) {
    const target = canonical.replace(/^\//, '').toLowerCase()
    aliasesOf.set(target, [...(aliasesOf.get(target) ?? []), alias.replace(/^\//, '').toLowerCase()])
  }
  // Recorded S17 (v0.22.0): `categories` holds the registry, the TUI's own
  // extras and the user's quick commands; SKILLS are only in the flat
  // `pairs` list (keyed in `skills`). So categories first, then whatever
  // `pairs` adds.
  const categories = [...(catalog.categories ?? []), { name: '', pairs: catalog.pairs ?? [] }]
  for (const category of categories) {
    for (const pair of category.pairs ?? []) {
      const rawName = String(pair[0] ?? '')
      const name = rawName.replace(/^\//, '').toLowerCase()
      if (!name || out.has(name)) continue
      const isSkill = Object.prototype.hasOwnProperty.call(catalog.skills ?? {}, rawName) || Object.prototype.hasOwnProperty.call(catalog.skills ?? {}, `/${name}`)
      out.set(name, {
        name,
        aliases: aliasesOf.get(name) ?? [],
        description: String(pair[1] ?? ''),
        category: category.name || (isSkill ? 'Skills' : 'Commands'),
        subcommands: catalog.sub?.[rawName] ?? catalog.sub?.[`/${name}`] ?? catalog.sub?.[name] ?? [],
        source: 'provider',
        // The "TUI" category is Hermes' terminal-only display toggles
        // (/density, /logs, /mouse; Desktop's TS_ONLY_NO_DESKTOP_SURFACE).
        availability: category.name === 'TUI'
          ? { kind: 'unavailable', reason: unavailableSentence(name, 'terminal') }
          : availabilityOf(name, catalog.commands?.[`/${name}`]?.desktop ?? catalog.commands?.[rawName]?.desktop),
      })
    }
  }
  for (const command of HERMES_APP_COMMANDS) if (!out.has(command.name)) out.set(command.name, command)
  // Typed before the catalog arrived (or against a server whose catalog
  // failed), a refused command must still be refused, not sent.
  for (const [name, reason] of Object.entries(APP_REFUSED)) {
    if (!out.has(name)) out.set(name, { name, aliases: [], description: '', category: 'Unavailable', subcommands: [], source: 'provider', availability: { kind: 'unavailable', reason } })
  }
  return [...out.values()]
}

/** The command a typed `/name …` resolves to (canonical name or alias). */
export function findComposerCommand(commands: readonly ComposerCommand[], typed: string): ComposerCommand | null {
  const name = typed.replace(/^\//, '').toLowerCase()
  return commands.find((command) => command.name === name || command.aliases.includes(name)) ?? null
}
