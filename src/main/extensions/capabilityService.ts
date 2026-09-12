import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { readBoundedTextFile } from '@main/editorFileIO.js'
import { resolveInsideRoot, validateExistingTarget } from '@main/ipc/editorFs.js'
import { extensionRevision, type ExtensionCapability } from '@shared/types/extensions.js'
import type { ExtensionServiceRequest, ExtensionTextFile } from '@shared/types/extensionServices.js'
import { installedExtensionCapabilities } from './grants.js'
import { onExtensionPublication } from './ledger.js'

// The runtime transport permits 128 KiB of string data per message. Leave room
// for object keys and path metadata, and bound bytes before UTF-8 decoding so a
// hostile sparse/generated file cannot create an oversized IPC allocation.
export const MAX_EXTENSION_TEXT_FILE_BYTES = 96 * 1024
const MAX_PENDING_PER_EXTENSION = 16

export type ExtensionCapabilityServiceOptions = {
  /** Resolve a main-owned live session id to its spawn cwd. */
  resolveSessionRoot(sessionId: string): string | null
}

type GrantCheck = { value: Promise<ReadonlySet<ExtensionCapability>> }

/**
 * Main-owned implementation of permissioned extension services.
 *
 * Both the isolated background runtime and a view's trusted parent broker call
 * this owner. That prevents the two transports from developing different path,
 * size, consent, or target rules. The extension id/revision arrive only from an
 * authenticated runtime or a host broker that fixed them before hearing child
 * input; an extension request never gets to choose another namespace.
 */
export class ExtensionCapabilityService {
  private readonly grants = new Map<string, GrantCheck>()
  private readonly pending = new Map<string, number>()
  private readonly unsubscribe: () => void

  constructor(private readonly options: ExtensionCapabilityServiceOptions) {
    this.unsubscribe = onExtensionPublication(rows => {
      // Publication is the revocation edge. A promise that verified the old
      // generation must not become a reusable grant after an update completed.
      // Preserve unrelated extensions' cached checks: installing a theme pack
      // must not cancel a reader's in-flight project operation.
      const active = new Set(rows.map(row => `${row.manifest.id}\u0000${extensionRevision(row)}`))
      for (const key of this.grants.keys()) {
        if (!active.has(key)) this.grants.delete(key)
      }
    })
  }

  async invoke(extensionId: string, revision: string, request: ExtensionServiceRequest): Promise<ExtensionTextFile> {
    const authority = `${extensionId}\u0000${revision}`
    const count = this.pending.get(authority) ?? 0
    if (count >= MAX_PENDING_PER_EXTENSION) {
      throw new Error('Too many extension service requests are pending.')
    }
    this.pending.set(authority, count + 1)
    try {
      const check = await this.requireCapability(extensionId, revision, 'fs.read')
      const result = await this.perform(request)
      // Do not return user data to a runtime/frame whose generation was revoked
      // while filesystem I/O was pending. The caller transport independently
      // checks its own document/runtime identity; this closes the main-service
      // side of the same race.
      if (this.grants.get(authority) !== check) throw new Error('This extension installation is no longer active.')
      return result
    } finally {
      const remaining = (this.pending.get(authority) ?? 1) - 1
      if (remaining) this.pending.set(authority, remaining)
      else this.pending.delete(authority)
    }
  }

  dispose(): void {
    this.unsubscribe()
    this.grants.clear()
    this.pending.clear()
  }

  private async requireCapability(
    extensionId: string,
    revision: string,
    capability: ExtensionCapability,
  ): Promise<GrantCheck> {
    const key = `${extensionId}\u0000${revision}`
    let check = this.grants.get(key)
    if (!check) {
      // Hash the committed bundle once per generation, then share that exact
      // verification across concurrent reads. Rehashing a 32 MiB bundle for every
      // 4 KiB project file would itself be an extension-controlled disk DoS.
      check = {
        value: installedExtensionCapabilities(extensionId, revision).then(value => new Set(value)),
      }
      this.grants.set(key, check)
    }
    const granted = await check.value
    if (this.grants.get(key) !== check) {
      throw new Error('This extension installation is no longer active.')
    }
    if (!granted.has(capability)) {
      throw new Error(`capability "${capability}" is not granted to ${extensionId}`)
    }
    return check
  }

  private async perform(request: ExtensionServiceRequest): Promise<ExtensionTextFile> {
    // This direct access is intentionally compile-sensitive: when the request
    // union gains a second member, TypeScript will stop allowing its fields here
    // until dispatch for that new member is made explicit.
    return this.readText(request.sessionId, request.path)
  }

  private async readText(sessionId: string, path: string): Promise<ExtensionTextFile> {
    const requestedRoot = this.options.resolveSessionRoot(sessionId)
    if (!requestedRoot) throw new Error('The target session is not active.')
    const root = await realpath(resolve(requestedRoot))
    const target = resolveInsideRoot(root, path)
    const physicalTarget = await validateExistingTarget(root, target)
    const observed = await stat(physicalTarget)
    if (!observed.isFile()) throw new Error('The target is not a file.')
    const bounded = await readBoundedTextFile(physicalTarget, MAX_EXTENSION_TEXT_FILE_BYTES).catch(error => {
      if (error instanceof Error && error.message === 'file is too large') {
        throw new Error(`Extension text reads are limited to ${MAX_EXTENSION_TEXT_FILE_BYTES} bytes.`)
      }
      throw error
    })
    return {
      sessionId,
      path: relative(root, target).replace(/\\/g, '/'),
      text: bounded.text,
      size: bounded.stat.size,
      mtimeMs: bounded.stat.mtimeMs,
    }
  }
}
