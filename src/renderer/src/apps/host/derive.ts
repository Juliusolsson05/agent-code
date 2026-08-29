import type { CommandDef } from '@renderer/features/command-palette/types'
import type { AppDefinition } from '@renderer/apps/types'
import { viewComponentFor } from '@renderer/apps/host/viewBridge'
import { dispatchToFrame, queuePendingCommand } from '@renderer/apps/host/frameRegistry'
import type { CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import { tryNormalizeKeybinding } from '@renderer/features/command-keybindings/normalize'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'
import type { ExtensionListEntry } from '@shared/types/extensions'

// Turning DECLARATIONS into app surfaces.
//
// The load-bearing property of everything here is that it reads the MANIFEST,
// never a loaded module. That is what makes lazy activation real: the palette
// lists an extension's commands and the app registry knows about its views while
// not a single extension bundle has been imported. Importing happens on first
// use, inside its own frame.
//
// Cross-extension id collisions are resolved here rather than at install: neither
// author can see the other's manifest, so failing the install would punish
// whoever happened to install second. First wins, and the loser is dropped
// rather than silently shadowing.

/** `AppDefinition`s for every contributed view. */
export function deriveAppDefinitions(installed: ExtensionListEntry[]): AppDefinition[] {
  const seen = new Set<string>()
  const definitions: AppDefinition[] = []

  for (const entry of installed) {
    if (!entry.present) continue
    for (const view of entry.manifest.contributes?.views ?? []) {
      if (seen.has(view.id)) continue
      seen.add(view.id)
      definitions.push({
        id: view.id,
        title: view.title,
        // A view has no description of its own; the extension's is the honest
        // fallback and is what the palette shows under the command.
        description: entry.manifest.description,
        keywords: entry.manifest.keywords,
        Component: viewComponentFor(entry, view.id),
      })
    }
  }

  return definitions
}

/**
 * `CommandDef`s for every contributed command.
 *
 * A command whose id matches a contributed VIEW id opens that view; anything
 * else dispatches to the extension's registered handler. That mapping is why the
 * timer can declare `timer.open` with no handler — opening a declared view is
 * the host's job, and a handler whose only body is "show my own view" would be a
 * worse version of the host's own routing.
 */
export function deriveExtensionCommands(
  installed: ExtensionListEntry[],
  openApp: (appId: string) => void,
  // Opens a contributed view as a PANE (a tile leaf) instead of a modal. A view
  // whose manifest `mount` is 'panel' routes here; 'modal' routes to openApp. Made
  // optional with a no-op default so the Settings call sites that only LIST commands
  // stay a 3-arg call — the routing still resolves there, it just never fires.
  openInPane: (viewId: string) => void = () => {},
): CommandDef[] {
  const seen = new Set<string>()
  const commands: CommandDef[] = []

  for (const entry of installed) {
    if (!entry.present) continue
    const views = entry.manifest.contributes?.views ?? []
    const viewIds = new Set(views.map(view => view.id))
    // Where each view wants to render, so an "open" command targets the right host
    // shell — a modal or a pane — from the same declaration.
    const viewMountById = new Map(views.map(view => [view.id, view.mount]))

    for (const command of entry.manifest.contributes?.commands ?? []) {
      if (seen.has(command.id)) continue
      seen.add(command.id)

      // `timer.open` -> view `timer.main`: an extension's "open" command with no
      // matching view id still needs a target, so a single-view extension gets
      // its only view. More than one view means the author has to be explicit,
      // and the command simply dispatches to a handler instead.
      const onlyView = viewIds.size === 1 ? [...viewIds][0] : undefined
      const targetView = viewIds.has(command.id)
        ? command.id
        : command.id.endsWith('.open') && onlyView
          ? onlyView
          : undefined

      commands.push({
        id: command.id,
        title: command.title,
        // buildCommandRegistry throws on a blank description, so the manifest's
        // extension-level description is the fallback rather than an empty
        // string — a missing description would be a launch crash.
        description: command.description ?? entry.manifest.description,
        // 'app': extensions are mode-independent. They have no relationship to
        // the tile tree or to Dispatch, so hiding them in either mode would be
        // wrong.
        surface: 'app',
        // Assigned HERE, not by each consumer. Two Settings surfaces used to
        // re-tag these with `.map(c => ({...c, category: 'extensions'}))` after
        // calling this function, and the command palette did not — so the same
        // command grouped under "Extensions" in the keybinding editor and under
        // "Other" in the palette, and sortCommands carried a comment asserting
        // extension commands "have no way to declare one at all". The manifest
        // still cannot set a category, which is the point: a third party must not
        // be able to file itself under a first-party heading. The HOST assigns it,
        // and one assignment site is what makes every consumer agree.
        category: 'extensions',
        keywords: command.keywords ?? [],
        run: ({ ui }) => {
          // A command that maps to a view is an "open" command — opening a declared
          // view is the host's job, not a handler's (an extension declaring a command
          // whose only body is "show my own view" would be a worse version of this).
          // The view's declared mount decides WHICH host shell opens it.
          if (targetView) {
            if (viewMountById.get(targetView) === 'panel') openInPane(targetView)
            else openApp(targetView)
            ui.closePalette()
            return
          }
          // Action command. It runs inside the extension's live frame — the ONLY
          // place the extension executes now that host-realm activation is gone. If a
          // frame is open, dispatch straight in. If not, open the extension's single
          // view to bring a frame up and QUEUE the command to fire the instant that
          // frame signals ready — so a cold "timer.start" opens the timer and starts
          // it in one action. With no view to open, the action cannot run yet; the
          // background-frame follow-up (Group A, A4) removes that last limitation.
          const extensionId = entry.manifest.id
          if (!dispatchToFrame(extensionId, command.id)) {
            if (onlyView) {
              queuePendingCommand(extensionId, command.id)
              // Honour the view's DECLARED mount, exactly as the targetView branch
              // above does. This called openApp() unconditionally, so a panel-only
              // extension's action command opened it as a floating modal — directly
              // contradicting its own manifest — because deriveAppDefinitions builds
              // an AppDefinition for every view regardless of declared mount.
              if (viewMountById.get(onlyView) === 'panel') openInPane(onlyView)
              else openApp(onlyView)
            }
          }
          ui.closePalette()
        },
      })
    }
  }

  return commands
}

/**
 * `CommandBindingDefault`s for every contributed keybinding.
 *
 * These are DEFAULTS, concatenated onto `buildDefaultKeybindings()` at every
 * `resolveEffectiveKeybindings` call site — a user override in
 * `commandKeybindingOverrides` still wins, exactly like a first-party default.
 * Reads manifests only (no bundle import), the sibling of `deriveExtensionCommands`.
 *
 * Three deliberate choices:
 * - The manifest `key` is freeform text; the resolver needs the canonical
 *   `Keybinding` form. `tryNormalizeKeybinding` returns null on garbage so one
 *   malformed manifest key is dropped rather than throwing the whole default table.
 * - Several `{command, key}` entries for one command collapse into that command's
 *   `bindings` array — the multi-chord case the resolver already models.
 * - Context is always 'global'. The manifest declares none, and 'global' is the
 *   strictest for collision-checking (it overlaps every context), so an extension
 *   binding errs toward being reported as a conflict rather than silently
 *   shadowing a contextual first-party chord. The reservation check that consumes
 *   these is what actually lets first-party win; see the WS2 wiring.
 */
export function deriveExtensionKeybindings(
  installed: ExtensionListEntry[],
): CommandBindingDefault[] {
  const byCommand = new Map<string, Keybinding[]>()
  const order: string[] = []

  for (const entry of installed) {
    if (!entry.present) continue
    for (const binding of entry.manifest.contributes?.keybindings ?? []) {
      const chord = tryNormalizeKeybinding(binding.key)
      if (!chord) continue
      let chords = byCommand.get(binding.command)
      if (chords === undefined) {
        chords = []
        byCommand.set(binding.command, chords)
        order.push(binding.command)
      }
      if (!chords.includes(chord)) chords.push(chord)
    }
  }

  return order.map(commandId => ({
    commandId,
    bindings: byCommand.get(commandId)!,
    context: 'global' as const,
  }))
}
