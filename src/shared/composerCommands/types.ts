// A provider's slash commands, as the composer's command picker shows them
// (#1497).
//
// WHY a provider-neutral shape (and not Hermes' catalog verbatim): this is
// the first catalog-driven picker in the app. Claude's picker reads Claude
// Code's own terminal screen; OpenCode has `listCommands()` in its package
// but no UI yet (#1492). Hermes fills this from `commands.catalog`, and
// another structured provider can adopt the same picker by implementing
// AgentSession.listComposerCommands.

export type ComposerCommandAvailability =
  /** Shown and runnable. */
  | { kind: 'offered' }
  /** Runnable when typed, never listed (Hermes `desktop: "hidden"`). */
  | { kind: 'hidden' }
  /** Listed so the user learns it exists, refused with this sentence when run. */
  | { kind: 'unavailable'; reason: string }

export type ComposerCommand = {
  /** Without the slash, lower case: `compress`. */
  name: string
  aliases: string[]
  description: string
  category: string
  /** Hermes' subcommands for the argument position (`/skills pending`). */
  subcommands: string[]
  /** `provider`: the provider runs it. `app`: Agent Code handles it (e.g. Hermes /restart). */
  source: 'provider' | 'app'
  availability: ComposerCommandAvailability
}
