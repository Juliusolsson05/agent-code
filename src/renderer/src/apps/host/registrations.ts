import type { Disposable, ViewMount } from '@renderer/apps/host/moduleContract'

/**
 * Where an activated extension's handlers live.
 *
 * WHY a host-owned store rather than letting each extension keep its own: the
 * palette invokes a command by id long after activation, and the view host
 * renders by id on demand. Both need a lookup that outlives the call to
 * `activate()` and that the host — not the extension — controls the lifetime of.
 *
 * Keyed by extension id first so `disposeAll(extensionId)` is a single map
 * delete. An extension being removed must not leave handlers behind that a stale
 * palette entry could still reach.
 */
export class ExtensionRegistrations {
  private commands = new Map<string, Map<string, () => void | Promise<void>>>()
  private views = new Map<string, Map<string, ViewMount>>()

  registerCommand(
    extensionId: string,
    commandId: string,
    run: () => void | Promise<void>,
  ): Disposable {
    const forExtension = this.commands.get(extensionId) ?? new Map()
    forExtension.set(commandId, run)
    this.commands.set(extensionId, forExtension)
    return {
      dispose: () => {
        // Guarded by identity: a late dispose from a stale closure must not
        // remove a handler that a subsequent re-activation registered.
        if (forExtension.get(commandId) === run) forExtension.delete(commandId)
      },
    }
  }

  registerView(extensionId: string, viewId: string, mount: ViewMount): Disposable {
    const forExtension = this.views.get(extensionId) ?? new Map()
    forExtension.set(viewId, mount)
    this.views.set(extensionId, forExtension)
    return {
      dispose: () => {
        if (forExtension.get(viewId) === mount) forExtension.delete(viewId)
      },
    }
  }

  getCommand(extensionId: string, commandId: string): (() => void | Promise<void>) | undefined {
    return this.commands.get(extensionId)?.get(commandId)
  }

  getView(extensionId: string, viewId: string): ViewMount | undefined {
    return this.views.get(extensionId)?.get(viewId)
  }

  disposeAll(extensionId: string): void {
    this.commands.delete(extensionId)
    this.views.delete(extensionId)
  }
}
