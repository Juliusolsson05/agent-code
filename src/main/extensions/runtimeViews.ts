import { randomUUID } from 'node:crypto'
import type { ExtensionJson, RuntimeChange, RuntimeViewEvent, RuntimeViewSnapshot } from '@shared/types/extensionRuntime.js'
import type { ExtensionRuntimeService } from './runtimeService.js'

type Connection = {
  owner: number
  connectionId: string
  instanceId: string
  extensionId: string
  revision: string
  viewId: string
}

// This registry is the main-side half of the view broker. The IPC adapter must
// derive owner from an authenticated application WebContents; extension code
// never supplies it. A connection fixes extension/generation/view authority once,
// so subsequent requests cannot switch namespace by changing payload fields.
export class ExtensionRuntimeViews {
  private readonly connections = new Map<string, Connection>()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly service: ExtensionRuntimeService, private readonly send: (owner: number, event: RuntimeViewEvent) => void) {
    this.unsubscribe = service.subscribe(this.onChange)
  }

  async attach(owner: number, connectionId: string, extensionId: string, revision: string, viewId: string, gate?: () => Promise<void>): Promise<{ instanceId: string; snapshot: RuntimeViewSnapshot }> {
    if (this.closed) throw new Error('Extension view host is stopped.')
    if (!connectionId || connectionId.length > 128) throw new Error('Invalid extension view connection.')
    const key = this.key(owner, connectionId)
    if (this.connections.has(key)) throw new Error('Extension view connection already exists.')
    if (this.connections.size >= 256 || [...this.connections.values()].filter(connection => connection.owner === owner).length >= 32) {
      throw new Error('Too many extension views are attached.')
    }
    const connection: Connection = { owner, connectionId, instanceId: randomUUID(), extensionId, revision, viewId }
    // Publish ownership BEFORE asynchronous activation. Closing a pane or its
    // whole window while activate() awaits storage must cancel this attachment,
    // and state published during activation must reach the pending subscriber.
    this.connections.set(key, connection)
    try {
      // The caller's ABI gate awaits a ledger read, so it runs only AFTER the
      // connection is registered above. A detach arriving during that read must
      // find and delete the reservation; when the gate ran first, the detach
      // deleted nothing and the attach then registered a connection nobody owned,
      // counting toward the per-window cap until the runtime or window went away.
      if (gate) {
        await gate()
        this.assertCurrent(connection)
      }
      await this.service.startView(extensionId, revision, viewId)
      this.assertCurrent(connection)
      return { instanceId: connection.instanceId, snapshot: this.service.viewSnapshot(extensionId, revision, viewId) }
    } catch (error) {
      if (this.connections.get(key) === connection) this.connections.delete(key)
      throw error
    }
  }

  async request(owner: number, connectionId: string, name: string, input: ExtensionJson): Promise<ExtensionJson | undefined> {
    const connection = this.connections.get(this.key(owner, connectionId))
    if (!connection) throw new Error('Extension view connection is closed.')
    const { extensionId, revision, viewId, instanceId } = connection
    const result = await this.service.requestFromView(extensionId, revision, { id: viewId, instanceId }, name, input, () => this.assertCurrent(connection))
    // A completed action is never replayed, but its reply belongs to the document
    // that issued it. It must not reach a replacement document using the same
    // WindowProxy after a close/retry or an installation publication.
    this.assertCurrent(connection)
    return result
  }

  detach(owner: number, connectionId: string): void {
    this.connections.delete(this.key(owner, connectionId))
    // Deliberately no runtime stop: views are consumers of extension-wide state,
    // and closing the final view must not stop commands or background work.
  }

  detachOwner(owner: number): void {
    for (const connection of this.connections.values()) {
      if (connection.owner === owner) this.detach(owner, connection.connectionId)
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.connections.clear()
  }

  private key(owner: number, connectionId: string): string { return `${owner}:${connectionId}` }

  private assertCurrent(connection: Connection): void {
    if (this.connections.get(this.key(connection.owner, connection.connectionId)) !== connection) throw new Error('Extension view connection is closed.')
  }

  private deliver(connection: Connection, event: RuntimeViewEvent): void {
    try { this.send(connection.owner, event) }
    catch { this.detach(connection.owner, connection.connectionId) }
  }

  private onChange = (event: RuntimeChange): void => {
    for (const connection of this.connections.values()) {
      if (event.kind === 'view') {
        if (connection.extensionId === event.extensionId && connection.revision === event.revision && connection.viewId === event.viewId) {
          this.deliver(connection, { kind: 'state', connectionId: connection.connectionId, snapshot: event.snapshot })
        }
      } else if (event.status.state === 'failed' || event.status.state === 'stopped') {
        if (connection.extensionId === event.status.extensionId && connection.revision === event.status.revision) {
          this.detach(connection.owner, connection.connectionId)
          this.deliver(connection, { kind: 'closed', connectionId: connection.connectionId, error: event.status.error ?? 'Extension runtime stopped.' })
        }
      }
    }
  }
}
