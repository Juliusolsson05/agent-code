import { execFile, spawn } from 'node:child_process'
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
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token'
const REFRESH_SKEW_MS = 5 * 60_000
const KEYRING_SERVICE = 'Codex Auth'

type CredentialRecord = {
  serialized: string
  generation: string
}

export type CodexCredentialSource = {
  load(): Promise<CredentialRecord | null>
  /** False means another process/account generation won the compare-and-swap. */
  save(serialized: string, expectedGeneration: string): Promise<boolean>
}

type BrokerOptions = {
  interactiveCodexHome: string
  snapshotFile: string
  source?: CodexCredentialSource
  fetchImpl?: typeof fetch
  now?: () => number
  refreshEndpoint?: string
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
 * Own the one refresh-token lineage shared by every parallel workflow attempt.
 *
 * WHY provider children receive an access-only snapshot: copying a reusable refresh token into a
 * common CODEX_HOME lets nine independent Codex processes race one-time token rotation. Sharing
 * the same file does not solve it—the processes cache the same generation before either writes.
 * This broker serializes refresh in the Electron main process, conditionally updates the original
 * credential generation, and gives children `chatgptAuthTokens` state with an empty refresh token.
 * A 401 can fail one attempt and be retried after the broker refreshes, but no child can consume or
 * corrupt the account's refresh lineage.
 */
export class CodexWorkflowAuthenticationBroker {
  readonly snapshotFile: string
  readonly #source: CodexCredentialSource
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #refreshEndpoint: string
  #preparing: Promise<void> | null = null

  constructor(options: BrokerOptions) {
    this.snapshotFile = resolve(options.snapshotFile)
    this.#source = options.source ?? new DefaultCodexCredentialSource(options.interactiveCodexHome)
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#refreshEndpoint = options.refreshEndpoint ?? DEFAULT_REFRESH_ENDPOINT
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
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

      let current = document
      if (tokenExpiresSoon(tokens.access_token, this.#now())) {
        if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
          throw new Error('Codex workflow access token expired and no refresh token is available')
        }
        const refreshed = await this.#refresh(tokens.refresh_token)
        current = {
          ...document,
          tokens: {
            ...tokens,
            ...(refreshed.id_token === undefined ? {} : { id_token: refreshed.id_token }),
            ...(refreshed.access_token === undefined ? {} : { access_token: refreshed.access_token }),
            ...(refreshed.refresh_token === undefined ? {} : { refresh_token: refreshed.refresh_token }),
          },
          last_refresh: new Date(this.#now()).toISOString(),
        }
        const saved = await this.#source.save(JSON.stringify(current), record.generation)
        if (!saved && attempt === 0) continue
        if (!saved) throw new Error('Codex authentication changed while persisting refreshed tokens')
      }

      const currentTokens = current.tokens
      if (!currentTokens || !currentTokens.access_token || !currentTokens.account_id) {
        throw new Error('Codex workflow refresh returned incomplete ChatGPT credentials')
      }
      await writePrivateJson(this.snapshotFile, {
        auth_mode: 'chatgptAuthTokens',
        OPENAI_API_KEY: null,
        tokens: {
          // This mirrors Codex's own external-auth conversion: the access JWT carries the claims
          // needed by the API client and becomes the serialized id-token representation too.
          id_token: currentTokens.access_token,
          access_token: currentTokens.access_token,
          refresh_token: '',
          account_id: currentTokens.account_id,
        },
        last_refresh: new Date(this.#now()).toISOString(),
      })
      return
    }
    throw new Error('Codex authentication changed repeatedly while preparing a workflow attempt')
  }

  async #refresh(refreshToken: string): Promise<{
    id_token?: string
    access_token?: string
    refresh_token?: string
  }> {
    const response = await this.#fetch(this.#refreshEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    if (!response.ok) {
      // Never include the authority body: authentication services frequently echo identifiers or
      // diagnostic token fragments. Status is sufficient for the attempt's durable error record.
      throw new Error(`Codex workflow authentication refresh failed with HTTP ${response.status}`)
    }
    const value = await response.json() as unknown
    if (!isObject(value)) throw new Error('Codex workflow authentication refresh returned invalid JSON')
    const result = {
      ...(typeof value.id_token === 'string' ? { id_token: value.id_token } : {}),
      ...(typeof value.access_token === 'string' ? { access_token: value.access_token } : {}),
      ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}),
    }
    if (result.access_token === undefined) {
      throw new Error('Codex workflow authentication refresh omitted the access token')
    }
    return result
  }
}

class DefaultCodexCredentialSource implements CodexCredentialSource {
  readonly #home: string
  readonly #file: FileCredentialSource
  #keyring: MacKeyringCredentialSource | null = null

  constructor(home: string) {
    this.#home = resolve(home)
    this.#file = new FileCredentialSource(resolve(home, 'auth.json'))
  }

  async load(): Promise<CredentialRecord | null> {
    const file = await this.#file.load()
    if (file !== null) return file
    if (process.platform !== 'darwin') return null
    this.#keyring ??= await MacKeyringCredentialSource.create(this.#home)
    return this.#keyring.load()
  }

  async save(serialized: string, expectedGeneration: string): Promise<boolean> {
    const file = await this.#file.load()
    if (file !== null) {
      return this.#file.save(serialized, expectedGeneration)
    }
    if (process.platform !== 'darwin') return false
    this.#keyring ??= await MacKeyringCredentialSource.create(this.#home)
    return this.#keyring.save(serialized, expectedGeneration)
  }
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

  async save(serialized: string, expectedGeneration: string): Promise<boolean> {
    const current = await this.load()
    if (current?.generation !== expectedGeneration) return false
    await writePrivateText(this.path, serialized)
    return true
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

  async save(serialized: string, expectedGeneration: string): Promise<boolean> {
    const current = await this.load()
    if (current?.generation !== expectedGeneration) return false

    // WHY password bytes go through stdin: `security -w <value>` exposes the complete refreshed
    // OAuth document in argv. Supplying `-w` as the final flag asks Security.framework's CLI to
    // read the secret interactively; a pipe provides that input without creating another file.
    await new Promise<void>((resolveSave, rejectSave) => {
      const child = spawn('/usr/bin/security', [
        'add-generic-password',
        '-U',
        '-s', KEYRING_SERVICE,
        '-a', this.account,
        '-w',
      ], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(0, 4_096)
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        rejectSave(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) resolveSave()
        else rejectSave(new Error(`macOS Keychain update failed with code ${code ?? 1}: ${stderr}`))
      })
      child.stdin?.end(`${serialized}\n`)
    })
    return true
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
