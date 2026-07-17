import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REFRESH_SKEW_MS = 5 * 60_000
const KEYRING_SERVICE = 'Codex Auth'

type CredentialRecord = {
  serialized: string
  generation: string
}

export type CodexCredentialSource = {
  load(): Promise<CredentialRecord | null>
}

type BrokerOptions = {
  interactiveCodexHome: string
  snapshotFile: string
  source?: CodexCredentialSource
  now?: () => number
}

type AuthDocument = {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string | null
  } | null
  last_refresh?: string | null
  [key: string]: unknown
}

/**
 * Copy interactive credentials into an access-only workflow snapshot.
 *
 * WHY provider children receive an access-only snapshot: copying a reusable refresh token into a
 * common CODEX_HOME lets nine independent Codex processes race one-time token rotation. The broker
 * deliberately does not refresh the interactive credential itself: the Codex CLI is another
 * process which can rotate the same one-time refresh token, and no in-process mutex or file CAS can
 * make that cross-process exchange atomic. Near expiry we fail closed and wait for interactive
 * Codex to publish a fresh access token. That is less seamless than competing for—and potentially
 * destroying—the user's login lineage.
 */
export class CodexWorkflowAuthenticationBroker {
  readonly snapshotFile: string
  readonly #source: CodexCredentialSource
  readonly #now: () => number
  #preparing: Promise<void> | null = null

  constructor(options: BrokerOptions) {
    this.snapshotFile = resolve(options.snapshotFile)
    this.#source = options.source ?? new DefaultCodexCredentialSource(options.interactiveCodexHome)
    this.#now = options.now ?? Date.now
  }

  prepare = async (): Promise<void> => {
    // WHY concurrent starts join one promise: the scheduler intentionally admits nine attempts at
    // once. A mutex that queues nine complete refresh/read/write cycles still creates avoidable
    // account churn; single-flight lets one generation produce one immutable snapshot for all.
    if (this.#preparing) return this.#preparing
    const preparing = this.#prepareCurrentGeneration()
    this.#preparing = preparing
    try {
      await preparing
    } finally {
      if (this.#preparing === preparing) this.#preparing = null
    }
  }

  async #prepareCurrentGeneration(): Promise<void> {
    const record = await this.#source.load()
    if (record === null) {
      await rm(this.snapshotFile, { force: true })
      return
    }
    const document = parseAuthDocument(record.serialized)
    if (typeof document.OPENAI_API_KEY === 'string' && document.OPENAI_API_KEY.length > 0) {
      await writePrivateJson(this.snapshotFile, {
        auth_mode: 'apikey',
        OPENAI_API_KEY: document.OPENAI_API_KEY,
        tokens: null,
        last_refresh: null,
      })
      return
    }

    const tokens = document.tokens
    if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
      throw new Error('Codex workflow authentication requires an API key or ChatGPT access token')
    }
    if (!tokens.account_id) {
      throw new Error('Codex workflow ChatGPT authentication is missing an account id')
    }
    if (tokenExpiresSoon(tokens.access_token, this.#now())) {
      // Remove an older snapshot before failing so a provider host cannot accidentally proceed with
      // stale credentials after this explicit freshness check rejected the interactive source.
      await rm(this.snapshotFile, { force: true })
      throw new Error(
        'Codex workflow access token is near expiry; run or reopen interactive Codex to refresh authentication, then retry the workflow',
      )
    }
    await writePrivateJson(this.snapshotFile, {
      auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null,
      tokens: {
        // The isolated provider receives no refresh capability. Only interactive Codex owns that
        // rotating credential lineage; workflow children can consume this bounded access grant.
        id_token: tokens.access_token,
        access_token: tokens.access_token,
        refresh_token: '',
        account_id: tokens.account_id,
      },
      last_refresh: new Date(this.#now()).toISOString(),
    })
  }
}

class DefaultCodexCredentialSource implements CodexCredentialSource {
  readonly #home: string
  readonly #file: FileCredentialSource
  #keyring: MacKeyringCredentialSource | null = null
  #mode: Promise<'file' | 'keyring' | 'auto' | 'ephemeral'> | null = null

  constructor(home: string) {
    this.#home = resolve(home)
    this.#file = new FileCredentialSource(resolve(home, 'auth.json'))
  }

  async load(): Promise<CredentialRecord | null> {
    const mode = await (this.#mode ??= readCredentialStoreMode(this.#home))
    if (mode === 'file') return this.#file.load()
    if (mode === 'ephemeral' || process.platform !== 'darwin') return null
    this.#keyring ??= await MacKeyringCredentialSource.create(this.#home)
    let keyring: CredentialRecord | null
    try {
      keyring = await this.#keyring.load()
    } catch (error) {
      if (mode === 'keyring') throw error
      return this.#file.load()
    }
    if (mode === 'keyring' || keyring !== null) return keyring
    // Codex Auto is keyring-first and falls back to auth.json only when the keyring is empty or
    // unavailable. Reading the file first can resurrect a stale account that Codex intentionally
    // superseded, so the broker mirrors upstream storage order exactly.
    return this.#file.load()
  }

}

async function readCredentialStoreMode(
  home: string,
): Promise<'file' | 'keyring' | 'auto' | 'ephemeral'> {
  let config: string
  try {
    config = await readFile(resolve(home, 'config.toml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'file'
    throw error
  }
  // Upstream defaults to file. This small parser intentionally accepts only the top-level scalar
  // used by Codex; stopping at the first TOML table prevents a profile-local lookalike from being
  // mistaken for the global effective setting without pulling a second TOML implementation into
  // Agent Code's authentication boundary.
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|ephemeral)["']\s*(?:#.*)?$/.exec(line)
    if (match?.[1]) return match[1] as 'file' | 'keyring' | 'auto' | 'ephemeral'
  }
  return 'file'
}

class FileCredentialSource implements CodexCredentialSource {
  constructor(private readonly path: string) {}

  async load(): Promise<CredentialRecord | null> {
    try {
      const serialized = await readFile(this.path, 'utf8')
      return { serialized, generation: digest(serialized) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

}

class MacKeyringCredentialSource implements CodexCredentialSource {
  private constructor(private readonly account: string) {}

  static async create(home: string): Promise<MacKeyringCredentialSource> {
    const canonical = await realpath(home).catch(() => resolve(home))
    const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
    return new MacKeyringCredentialSource(`cli|${key}`)
  }

  async load(): Promise<CredentialRecord | null> {
    try {
      const result = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s', KEYRING_SERVICE,
        '-a', this.account,
        '-w',
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
      const serialized = result.stdout.trimEnd()
      return { serialized, generation: digest(serialized) }
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null
      throw new Error('Unable to read Codex authentication from macOS Keychain', { cause: error })
    }
  }

}

function parseAuthDocument(serialized: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch (cause) {
    throw new Error('Codex authentication is not valid JSON', { cause })
  }
  if (!isObject(value)) throw new Error('Codex authentication must be a JSON object')
  return value as AuthDocument
}

function tokenExpiresSoon(token: string, now: number): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return false
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    return isObject(claims) && typeof claims.exp === 'number'
      ? claims.exp * 1_000 <= now + REFRESH_SKEW_MS
      : false
  } catch {
    // API-key-like/non-JWT access tokens cannot be proactively inspected. The provider will return
    // an auth failure instead of this broker guessing that an opaque token has expired.
    return false
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value)}\n`)
}

async function writePrivateText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
