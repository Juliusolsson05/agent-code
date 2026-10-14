// Hermes bearer tokens, encrypted at rest, bound to the URL they were issued by.
//
// One safeStorage blob per connection: `<dir>/<connectionId>.bin`.
//
// WHY safeStorage and not the API Key Vault: the vault gates every read
// behind Touch ID once per run. Hermes panes reconnect UNATTENDED (workspace
// restore at launch, wake from sleep, a dropped Wi-Fi); a prompt before every
// reconnect, or panes that stay dead until the user unlocks something, are
// both worse. Same reasoning and same codec as src/main/userMcp/secrets.ts.
//
// WHY destination binding (the #1304 lesson in userMcp/secrets.ts): the
// plaintext is `{baseUrl, tokens}`. A read supplies the connection's CURRENT
// normalized URL and gets the tokens only if it matches. If the user edits a
// connection's URL, or a crash leaves the document and the blob out of step,
// the token simply reads as "signed out" and is never sent to a host it was
// not issued by.

import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import type { HermesTokens } from 'hermes-headless'

const PREFIX = 'agent-code/hermes-tokens/v1:'

// Connection ids are minted by main (randomUUID); this guard keeps any other
// value from becoming a path segment.
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

export class HermesTokenStore {
  /**
   * Per-connection queue of writes and deletes. Several owners touch one
   * blob (a sign-in, a refreshing broker, Sign out, a URL edit, Remove) and
   * each of their steps is async; unserialized, an OLD owner's slow write
   * landed after a NEWER sign-in and its cleanup then deleted the new pair
   * (round-2 review c2 #2). Queued, and with the owner check made at the
   * moment a write runs (`isCurrent`), a stale owner can neither overwrite
   * nor delete a later owner's tokens.
   */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly dir: string, private readonly codec: SecretCodec) {}

  private exclusive<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(connectionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.chains.set(connectionId, next.catch(() => undefined))
    return next
  }

  available(): boolean {
    try {
      return this.codec.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private path(connectionId: string): string {
    if (!SAFE_ID.test(connectionId)) throw new Error(`Invalid Hermes connection id: ${connectionId}`)
    return join(this.dir, `${connectionId}.bin`)
  }

  /** The tokens, only if they were issued for exactly `baseUrl`. */
  async get(connectionId: string, baseUrl: string): Promise<HermesTokens | null> {
    let cipher: Buffer
    try {
      cipher = await readFile(this.path(connectionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!this.available()) return null
    let plain: string
    try {
      plain = this.codec.decrypt(cipher)
    } catch {
      // A Keychain reset or a copied profile: the blob is unreadable, which
      // for the user means "sign in again", not a crash.
      return null
    }
    if (!plain.startsWith(PREFIX)) return null
    try {
      const record = JSON.parse(plain.slice(PREFIX.length)) as { baseUrl?: unknown; tokens?: HermesTokens }
      if (record.baseUrl !== baseUrl || !record.tokens || typeof record.tokens.accessToken !== 'string') return null
      return record.tokens
    } catch {
      return null
    }
  }

  /**
   * Write the pair, unless `isCurrent` says the writer no longer owns the
   * connection by the time its turn comes. Resolves whether it wrote.
   */
  async set(connectionId: string, baseUrl: string, tokens: HermesTokens, isCurrent: () => boolean = () => true): Promise<boolean> {
    const target = this.path(connectionId)
    return this.exclusive(connectionId, async () => {
      if (!isCurrent()) return false
      if (!this.available()) throw new Error('Secure storage is not available on this system, so Hermes sign-in cannot be saved.')
      await mkdir(this.dir, { recursive: true })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, this.codec.encrypt(PREFIX + JSON.stringify({ baseUrl, tokens })), { mode: 0o600 })
      await rename(temporary, target)
      return true
    })
  }

  /** Delete the pair, with the same owner check as set(). Resolves whether it deleted. */
  async delete(connectionId: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const target = this.path(connectionId)
    return this.exclusive(connectionId, async () => {
      if (!isCurrent()) return false
      await rm(target, { force: true })
      return true
    })
  }
}
