import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import type {
  Disposable,
  ExtensionContext,
  ExtensionModule,
  ViewMount,
} from '@renderer/apps/host/moduleContract'
import type { ExtensionListEntry } from '@shared/types/extensions'

import { ExtensionRegistrations } from '@renderer/apps/host/registrations'

export type ExtensionFailure = { id: string; name: string; error: string }

type Loaded = {
  entry: ExtensionListEntry
  module: ExtensionModule
  context: ExtensionContext
}

/**
 * Imports, activates and disposes installed extensions.
 *
 * WHY every failure is a VALUE and never a throw: an extension is third-party
 * code loaded at runtime. A module that fails to import, exports no `activate`,
 * or throws inside it must leave every other extension running and must not be
 * able to blank the renderer. Failures accumulate in `failures` and are surfaced
 * in Settings, where the user can act on them.
 *
 * WHY activation is memoized on the in-flight promise rather than a boolean:
 * two triggers can race — a palette command and a view open in the same frame —
 * and a boolean set after the await would let both run `activate()`. Storing the
 * promise means the second caller joins the first.
 */
export class ExtensionHost {
  private loaded = new Map<string, Loaded>()
  private activating = new Map<string, Promise<void>>()
  private registrations = new ExtensionRegistrations()
  private failures: ExtensionFailure[] = []

  constructor(
    /** Builds the per-extension API instance. Injected so the host does not
     *  reach into React context, and so tests can supply a fake. */
    private makeApi: (extensionId: string) => AgentCodeApiV1,
    private onFailuresChanged: (failures: ExtensionFailure[]) => void,
  ) {}

  getFailures(): ExtensionFailure[] {
    return this.failures
  }

  isActivated(extensionId: string): boolean {
    return this.loaded.has(extensionId)
  }

  /**
   * Import and activate, once.
   *
   * The single line of actual loading is the dynamic import below. `@vite-ignore`
   * stops Vite trying to analyze a runtime specifier at build time; Rollup passes
   * a variable import() through untouched either way — Monaco's own foreign-module
   * loader does exactly this in the shipped bundle, which is what retired the risk
   * that it would not survive the build. The B1 spike then proved it works over
   * agent-code-ext:// from a file:// document.
   */
  async activate(entry: ExtensionListEntry): Promise<void> {
    const id = entry.manifest.id
    if (this.loaded.has(id)) return
    const inFlight = this.activating.get(id)
    if (inFlight) return inFlight

    const run = (async () => {
      try {
        // The version+sha query is a CACHE KEY, not decoration.
        //
        // The ES module registry caches by URL, and it caches FAILURES too: once
        // `import(url)` rejects, every later import of that exact URL returns the
        // same rejection for the life of the realm — even after the file on disk
        // has been replaced. Without this, an extension that fails once can never
        // be fixed by reinstalling; the user updates it, sees the identical error,
        // and has no way to tell that their fix did land. Reloading the window is
        // the only escape, and nothing tells them that.
        //
        // The sha is already the installer's integrity record, so it changes
        // exactly when the bytes change — which is precisely the condition under
        // which the module must be re-evaluated.
        const cacheKey = `${entry.manifest.version}-${entry.sha256.slice(0, 12)}`
        const url = `agent-code-ext://${id}/${entry.manifest.entry}?v=${cacheKey}`
        const module = (await import(/* @vite-ignore */ url)) as ExtensionModule

        if (typeof module.activate !== 'function') {
          // The most likely authoring mistake by a wide margin, so it gets its
          // own message rather than surfacing as a TypeError from a call site.
          throw new Error('entry module does not export an activate(context) function')
        }

        const context = this.makeContext(entry)
        await module.activate(context)
        this.loaded.set(id, { entry, module, context })
        this.clearFailure(id)
      } catch (error) {
        this.recordFailure(id, entry.manifest.name, error)
      } finally {
        this.activating.delete(id)
      }
    })()

    this.activating.set(id, run)
    return run
  }

  async deactivate(extensionId: string): Promise<void> {
    const loaded = this.loaded.get(extensionId)
    if (!loaded) return
    this.loaded.delete(extensionId)

    try {
      await loaded.module.deactivate?.()
    } catch (error) {
      // A throwing deactivate must not prevent disposal — the subscriptions are
      // the host's cleanup contract, and skipping them would leak intervals and
      // listeners for the rest of the session.
      this.recordFailure(extensionId, loaded.entry.manifest.name, error)
    }

    // Reverse order: later subscriptions were created against earlier ones, so
    // disposing forwards can tear down a dependency while a dependant still
    // holds it. This is the same ordering every disposable stack uses, for the
    // same reason.
    for (const subscription of [...loaded.context.subscriptions].reverse()) {
      try {
        subscription.dispose()
      } catch {
        // One bad disposer must not strand the rest.
      }
    }

    this.registrations.disposeAll(extensionId)
  }

  async deactivateAll(): Promise<void> {
    await Promise.all([...this.loaded.keys()].map(id => this.deactivate(id)))
  }

  /**
   * Run a contributed command, activating the extension first if needed.
   *
   * This is what makes `onCommand:` activation real: the palette lists the
   * command from the manifest, and the module is imported only when it is
   * actually invoked.
   */
  async executeCommand(entry: ExtensionListEntry, commandId: string): Promise<void> {
    await this.activate(entry)
    const handler = this.registrations.getCommand(entry.manifest.id, commandId)
    if (!handler) {
      // Declared but never registered. Not a crash: an extension may reasonably
      // declare a command whose only meaning is "open my view", which the host
      // resolves without a handler.
      return
    }
    try {
      await handler()
    } catch (error) {
      this.recordFailure(entry.manifest.id, entry.manifest.name, error)
    }
  }

  /** The mount registered for a view, if its extension has activated. */
  getView(extensionId: string, viewId: string): ViewMount | undefined {
    return this.registrations.getView(extensionId, viewId)
  }

  private makeContext(entry: ExtensionListEntry): ExtensionContext {
    const id = entry.manifest.id
    const declaredCommands = new Set(
      (entry.manifest.contributes?.commands ?? []).map(command => command.id),
    )
    const declaredViews = new Set((entry.manifest.contributes?.views ?? []).map(view => view.id))
    const subscriptions: Disposable[] = []

    return {
      api: this.makeApi(id),
      subscriptions,

      registerCommand: (commandId, run) => {
        // Rejecting an undeclared id is deliberate. A handler the palette has no
        // entry for can never be invoked, so silently accepting it would leave
        // the author with a command that does nothing and no clue why. The throw
        // is caught by activate() and shown as an extension failure.
        if (!declaredCommands.has(commandId)) {
          throw new Error(
            `registerCommand("${commandId}") — not declared in contributes.commands`,
          )
        }
        return this.registrations.registerCommand(id, commandId, run)
      },

      registerView: (viewId, mount) => {
        if (!declaredViews.has(viewId)) {
          throw new Error(`registerView("${viewId}") — not declared in contributes.views`)
        }
        return this.registrations.registerView(id, viewId, mount)
      },
    }
  }

  private recordFailure(id: string, name: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.failures = [...this.failures.filter(failure => failure.id !== id), { id, name, error: message }]
    this.onFailuresChanged(this.failures)
    // Also to the console: Settings shows the message, but a stack is what
    // actually locates a bug inside third-party code.
    console.warn(`[extensions] ${id} failed:`, error)
  }

  private clearFailure(id: string): void {
    if (!this.failures.some(failure => failure.id === id)) return
    this.failures = this.failures.filter(failure => failure.id !== id)
    this.onFailuresChanged(this.failures)
  }
}
