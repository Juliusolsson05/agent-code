import { lstat, realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import {
  atomicWriteTextFile,
  readBoundedTextFile,
  serializeEditorFileMutation,
} from '@main/editorFileIO.js'
import {
  invalidateEditorFsCache,
  resolveInsideRoot,
  resolveThroughExistingParent,
  validateExistingTarget,
} from '@main/ipc/editorFs.js'
import { extensionRevision, type ExtensionCapability } from '@shared/types/extensions.js'
import type {
  ExtensionServiceRequest,
  ExtensionServiceResult,
  ExtensionTextFile,
  ExtensionTextFileWrite,
} from '@shared/types/extensionServices.js'
import { installedExtensionCapabilities } from './grants.js'
import { onExtensionPublication } from './ledger.js'

// The runtime transport permits 128 KiB of string data per message. Leave room
// for object keys and path metadata, and bound bytes before UTF-8 decoding so a
// hostile sparse/generated file cannot create an oversized IPC allocation.
export const MAX_EXTENSION_TEXT_FILE_BYTES = 96 * 1024
export const MAX_EXTENSION_TEXT_WRITE_BYTES = 64 * 1024
const MAX_PENDING_PER_EXTENSION = 16

// A service method cannot compile until its permission is named here. Keeping
// this as data beside the main implementation avoids a new mutation accidentally
// inheriting the read grant just because both methods live under api.files.
const REQUIRED_CAPABILITY: Record<ExtensionServiceRequest['method'], ExtensionCapability> = {
  'fs.readText': 'fs.read',
  'fs.writeText': 'fs.write',
  'notifications.show': 'notifications.show',
}

export type ExtensionCapabilityServiceOptions = {
  /** Resolve a main-owned live session id to its spawn cwd. */
  resolveSessionRoot(sessionId: string): string | null
  /** Deliver a bounded extension-attributed status to application windows. */
  notify(extensionId: string, message: string): void
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

  async invoke(extensionId: string, revision: string, request: ExtensionServiceRequest): Promise<ExtensionServiceResult> {
    const authority = `${extensionId}\u0000${revision}`
    const count = this.pending.get(authority) ?? 0
    if (count >= MAX_PENDING_PER_EXTENSION) {
      throw new Error('Too many extension service requests are pending.')
    }
    this.pending.set(authority, count + 1)
    try {
      const check = await this.requireCapability(extensionId, revision, REQUIRED_CAPABILITY[request.method])
      const result = await this.perform(extensionId, request, authority, check)
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

  private async perform(
    extensionId: string,
    request: ExtensionServiceRequest,
    authority: string,
    check: GrantCheck,
  ): Promise<ExtensionServiceResult> {
    switch (request.method) {
      case 'fs.readText':
        return this.readText(request.sessionId, request.path)
      case 'fs.writeText':
        return this.writeText(
          request.sessionId,
          request.path,
          request.text,
          request.expectedVersion,
          () => {
            if (this.grants.get(authority) !== check) {
              throw new Error('This extension installation is no longer active.')
            }
          },
        )
      case 'notifications.show':
        // The caller's id is fixed by the authenticated runtime/frame. Keep it
        // beside the message so renderer chrome can attribute third-party text.
        this.options.notify(extensionId, request.message)
        return undefined
      default: {
        const unhandled: never = request
        throw new Error(`Unhandled extension service request: ${String(unhandled)}`)
      }
    }
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
      version: bounded.version,
    }
  }

  private async writeText(
    sessionId: string,
    path: string,
    text: string,
    expectedVersion: string | null,
    assertCanPublish: () => void,
  ): Promise<ExtensionTextFileWrite> {
    const requestedRoot = this.options.resolveSessionRoot(sessionId)
    if (!requestedRoot) throw new Error('The target session is not active.')
    if (text.includes('\u0000') || Buffer.from(text, 'utf8').toString('utf8') !== text) {
      throw new Error('Extension file writes require valid UTF-8 text without NUL bytes.')
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_EXTENSION_TEXT_WRITE_BYTES) {
      throw new Error(`Extension text writes are limited to ${MAX_EXTENSION_TEXT_WRITE_BYTES} bytes.`)
    }

    const root = await realpath(resolve(requestedRoot))
    const target = resolveInsideRoot(root, path)
    // New files have no leaf to canonicalize, so resolve the existing parent and
    // perform the syscall through that physical path. This is the same authority
    // rule as the editor: a symlinked parent cannot redirect a write outside the
    // session project after a purely lexical containment check.
    const physicalTarget = await resolveThroughExistingParent(root, target)
    const exists = await lstat(physicalTarget).then(
      () => true,
      error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      },
    )
    if (exists) await validateExistingTarget(root, physicalTarget)

    return serializeEditorFileMutation(physicalTarget, async () => {
      const result = await atomicWriteTextFile({
        absolutePath: physicalTarget,
        text,
        expectedVersion,
        maxBytes: MAX_EXTENSION_TEXT_WRITE_BYTES,
        assertCanPublish,
      })
      if (!result.ok) {
        throw new Error(
          result.conflictKind === 'deleted'
            ? 'The target file was deleted after it was read.'
            : 'The target file changed after it was read.',
        )
      }
      const projectPath = relative(root, target).replace(/\\/g, '/')
      // The editor cache is shared process state. A safe extension write that
      // leaves it populated would make the trusted editor show obsolete bytes.
      invalidateEditorFsCache(root, projectPath)
      return {
        sessionId,
        path: projectPath,
        size: result.stat.size,
        mtimeMs: result.stat.mtimeMs,
        version: result.version,
      }
    })
  }
}
