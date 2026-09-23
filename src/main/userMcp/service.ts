import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import {
  addCodexUserMcpLaunchConfig,
  claudeUserMcpEntries,
  type ResolvedUserMcpServer,
} from '@providers/shared/runtime/userMcpLaunch.js'
import { importUserMcpConfig } from '@shared/userMcp/importConfig.js'
import {
  isUserMcpProvider,
  type NativeMcpServer,
  type UserMcpDocument,
  type UserMcpDroppedServer,
  type UserMcpImportResult,
  type UserMcpMutationResult,
  type UserMcpProblem,
  type UserMcpProvider,
  type UserMcpSaveInput,
  type UserMcpServer,
  type UserMcpServerView,
  type UserMcpSnapshot,
} from '@shared/userMcp/types.js'
import {
  coerceInputs,
  normalizeEntry,
  providerSupport,
  referencedInputIds,
  summarizeEntry,
  transportOf,
  validateServer,
} from '@shared/userMcp/validate.js'

import {
  claudeManagedMcpPolicyPresent,
  codexNativeServerNames,
  readNativeMcpServers,
} from './nativeServers.js'
import { UserMcpSecretStore } from './secrets.js'
import { loadUserMcpDocument, saveUserMcpDocument } from './store.js'

export type UserMcpLaunchResolution = {
  servers: ResolvedUserMcpServer[]
  attachedIds: string[]
  dropped: UserMcpDroppedServer[]
}

export type UserMcpServiceDeps = {
  stateDir: string
  codec: SecretCodec
  /** Injectable for tests; production reads the real CLI config files. */
  native?: {
    list(): Promise<NativeMcpServer[]>
    codexNames(cwd: string): Promise<Set<string>>
    claudeManagedPolicy(): Promise<boolean>
  }
}

/**
 * Single owner of user MCP servers (#1143): the document, the secrets, and the
 * launch-time decision of what attaches to which agent.
 *
 * WHY main decides what attaches, not the renderer (spec Revision 2 §4): main
 * owns the document and the only copy of the secrets, and a renderer holding a
 * stale snapshot must not be able to attach a server the user has since
 * deleted or switched off. The renderer contributes only the pane's explicit
 * per-agent choices; everything else is read here at launch.
 */
export class UserMcpService {
  private document: UserMcpDocument = { version: 1, servers: [] }
  private storeProblem: string | undefined
  private readonly file: string
  private readonly secrets: UserMcpSecretStore
  private readonly native: NonNullable<UserMcpServiceDeps['native']>
  private readonly listeners = new Set<(snapshot: UserMcpSnapshot) => void>()
  // Every mutation runs after the previous one settles. Two windows toggling
  // at once would otherwise both read-modify-write the same document and the
  // later write would silently discard the earlier change.
  private tail: Promise<unknown> = Promise.resolve()
  private initialized: Promise<void> | null = null

  constructor(deps: UserMcpServiceDeps) {
    this.file = join(deps.stateDir, 'mcp-servers.json')
    this.secrets = new UserMcpSecretStore(join(deps.stateDir, 'mcp-secrets'), deps.codec)
    this.native = deps.native ?? {
      list: () => readNativeMcpServers(),
      codexNames: cwd => codexNativeServerNames(cwd),
      claudeManagedPolicy: () => claudeManagedMcpPolicyPresent(),
    }
  }

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const loaded = await loadUserMcpDocument(this.file)
      this.document = loaded.document
      this.storeProblem = loaded.problem
    })()
    return this.initialized
  }

  onChange(listener: (snapshot: UserMcpSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async snapshot(): Promise<UserMcpSnapshot> {
    await this.initialize()
    const [native, claudeManagedPolicy] = await Promise.all([
      this.native.list().catch(() => [] as NativeMcpServer[]),
      this.native.claudeManagedPolicy().catch(() => false),
    ])
    const servers = await Promise.all(this.document.servers.map(server => this.view(server, claudeManagedPolicy)))
    return {
      servers,
      native,
      claudeManagedPolicy,
      ...(this.storeProblem ? { storeProblem: this.storeProblem } : {}),
    }
  }

  importConfig(text: string, fallbackName?: string): UserMcpImportResult {
    return importUserMcpConfig(text, fallbackName)
  }

  save(input: UserMcpSaveInput): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const existing = input.id ? this.document.servers.find(server => server.id === input.id) : undefined
      if (input.id && !existing) return { ok: false, error: 'That server no longer exists.' }
      const server: UserMcpServer = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        enabled: input.enabled,
        providers: { claude: input.providers.claude === true, codex: input.providers.codex === true },
        entry: normalizeEntry(input.entry),
        inputs: coerceInputs(input.inputs),
      }
      const others = this.document.servers.filter(other => other.id !== server.id)
      // Structural problems block the save. A missing secret does not: it is a
      // normal intermediate state (paste config now, fetch the token later),
      // and launch already refuses to attach the server until it is set.
      const problems = validateServer(server, others)
      if (problems.length > 0) return { ok: false, error: problems[0]!.message, problems }
      for (const [inputId, value] of Object.entries(input.secrets ?? {})) {
        if (server.inputs.some(candidate => candidate.id === inputId)) {
          await this.secrets.set(server.id, inputId, value)
        }
      }
      await this.secrets.prune(server.id, server.inputs.map(candidate => candidate.id))
      this.document = {
        version: 1,
        servers: existing
          ? this.document.servers.map(candidate => candidate.id === server.id ? server : candidate)
          : [...this.document.servers, server],
      }
      await this.persist()
      return { ok: true, id: server.id }
    })
  }

  delete(id: string): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      if (!this.document.servers.some(server => server.id === id)) return { ok: false, error: 'That server no longer exists.' }
      this.document = { version: 1, servers: this.document.servers.filter(server => server.id !== id) }
      await this.persist()
      await this.secrets.clearServer(id)
      return { ok: true }
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<UserMcpMutationResult> {
    return this.update(id, server => ({ ...server, enabled }))
  }

  setProvider(id: string, provider: UserMcpProvider, enabled: boolean): Promise<UserMcpMutationResult> {
    return this.update(id, server => ({ ...server, providers: { ...server.providers, [provider]: enabled } }))
  }

  setSecret(id: string, inputId: string, value: string): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const server = this.document.servers.find(candidate => candidate.id === id)
      if (!server) return { ok: false, error: 'That server no longer exists.' }
      if (!server.inputs.some(input => input.id === inputId)) return { ok: false, error: `No secret named "${inputId}".` }
      await this.secrets.set(id, inputId, value)
      return { ok: true }
    })
  }

  /**
   * Copy a CLI-native server into Agent Code.
   *
   * The copy starts attached only to the OTHER provider. WHY: the source CLI
   * keeps loading its own entry, so attaching the copy there too duplicates it
   * — and for Codex, a same-name launch entry is refused at launch (see
   * codexNativeServerNames). Sharing a server the user set up in one CLI with
   * the other is the main reason to copy it in.
   */
  copyNative(provider: UserMcpProvider, name: string): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const native = (await this.native.list()).find(server => server.provider === provider && server.name === name)
      if (!native?.entry) return { ok: false, error: 'That server can no longer be read from its config file.' }
      const others = this.document.servers
      const server: UserMcpServer = {
        id: randomUUID(),
        name: native.name,
        enabled: true,
        providers: { claude: provider !== 'claude', codex: provider !== 'codex' },
        entry: normalizeEntry(native.entry),
        inputs: native.inputs,
      }
      const problems = validateServer(server, others)
      if (problems.length > 0) return { ok: false, error: problems[0]!.message, problems }
      this.document = { version: 1, servers: [...others, server] }
      await this.persist()
      return { ok: true, id: server.id }
    })
  }

  /**
   * Decide and materialize the user servers for one agent launch.
   *
   * `overrides` are the pane's explicit per-agent choices (bare server ids).
   * Order of rules, and why:
   *  1. master switch off → skip silently. The user turned it off everywhere,
   *     so there is nothing to warn about, even for a per-agent "on".
   *  2. not requested (no override and provider default off) → skip silently.
   *  3. requested but unusable (invalid, unsupported transport, enterprise
   *     policy, native name collision, missing secret, translator refusal) →
   *     drop WITH a reason. The user asked for it, so silence would read as
   *     "it's attached" while the agent has no such tools.
   * A dropped server never fails the launch.
   */
  async resolveForLaunch(params: {
    provider: string
    overrides: Readonly<Record<string, boolean>>
    cwd: string
  }): Promise<UserMcpLaunchResolution> {
    await this.initialize()
    const empty: UserMcpLaunchResolution = { servers: [], attachedIds: [], dropped: [] }
    if (!isUserMcpProvider(params.provider)) return empty
    const provider = params.provider
    const requested = this.document.servers.filter(server =>
      server.enabled && (params.overrides[server.id] ?? server.providers[provider]))
    if (requested.length === 0) return empty

    const dropped: UserMcpDroppedServer[] = []
    const candidates: ResolvedUserMcpServer[] = []
    const claudeManaged = provider === 'claude' && await this.native.claudeManagedPolicy().catch(() => false)
    const codexNames = provider === 'codex'
      ? await this.native.codexNames(params.cwd).catch(() => new Set<string>())
      : new Set<string>()
    for (const server of requested) {
      const others = this.document.servers.filter(other => other.id !== server.id)
      const problem = validateServer(server, others)[0]
      if (problem) {
        dropped.push({ name: server.name, reason: problem.message })
        continue
      }
      const support = providerSupport(transportOf(server.entry))[provider]
      if (!support.ok) {
        dropped.push({ name: server.name, reason: support.reason })
        continue
      }
      if (claudeManaged) {
        dropped.push({ name: server.name, reason: "Your organization's Claude MCP policy only allows its own servers" })
        continue
      }
      if (codexNames.has(server.name)) {
        dropped.push({ name: server.name, reason: 'A server with this name is already in your Codex config.toml' })
        continue
      }
      const secrets: Record<string, string> = {}
      let missing: string | null = null
      for (const inputId of referencedInputIds(server.entry)) {
        const value = await this.secrets.get(server.id, inputId)
        if (value === null) {
          missing = inputId
          break
        }
        secrets[inputId] = value
      }
      if (missing) {
        dropped.push({ name: server.name, reason: `Secret "${missing}" is not set` })
        continue
      }
      candidates.push({ id: server.id, name: server.name, entry: server.entry, secrets })
    }

    // Dry-run the provider translator here, where drops can be reported, so
    // the provider session never has to silently omit a server it was handed.
    // Both translators are pure and deterministic over the same input.
    const translatorDrops = provider === 'claude'
      ? claudeUserMcpEntries(candidates).dropped
      : addCodexUserMcpLaunchConfig(candidates, [], {})
    const refused = new Set(translatorDrops.map(server => server.name))
    dropped.push(...translatorDrops)
    const servers = candidates.filter(server => !refused.has(server.name))
    return { servers, attachedIds: servers.map(server => server.id), dropped }
  }

  private update(id: string, change: (server: UserMcpServer) => UserMcpServer): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const server = this.document.servers.find(candidate => candidate.id === id)
      if (!server) return { ok: false, error: 'That server no longer exists.' }
      this.document = {
        version: 1,
        servers: this.document.servers.map(candidate => candidate.id === id ? change(candidate) : candidate),
      }
      await this.persist()
      return { ok: true }
    })
  }

  private mutate(
    operation: () => Promise<{ ok: true; id?: string } | { ok: false; error: string; problems?: UserMcpProblem[] }>,
  ): Promise<UserMcpMutationResult> {
    const run = this.tail.then(async (): Promise<UserMcpMutationResult> => {
      await this.initialize()
      try {
        const outcome = await operation()
        if (!outcome.ok) return outcome
        const snapshot = await this.snapshot()
        for (const listener of this.listeners) listener(snapshot)
        return { ok: true, snapshot, ...(outcome.id ? { id: outcome.id } : {}) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    this.tail = run.catch(() => {})
    return run
  }

  private async persist(): Promise<void> {
    await saveUserMcpDocument(this.file, this.document)
    // A successful write supersedes whatever made the old file unreadable.
    this.storeProblem = undefined
  }

  private async view(server: UserMcpServer, claudeManagedPolicy: boolean): Promise<UserMcpServerView> {
    const transport = transportOf(server.entry)
    const others = this.document.servers.filter(other => other.id !== server.id)
    const secrets = await this.secrets.state(server.id, server.inputs.map(input => input.id))
    const problems = validateServer(server, others)
    for (const inputId of referencedInputIds(server.entry)) {
      if (secrets[inputId] && !secrets[inputId]!.set) {
        problems.push({ kind: 'secret-missing', message: `Secret "${inputId}" is not set` })
      }
    }
    const support = providerSupport(transport)
    return {
      ...server,
      transport,
      summary: summarizeEntry(server.entry),
      secrets,
      problems,
      support: claudeManagedPolicy
        ? { ...support, claude: { ok: false, reason: "Your organization's Claude MCP policy only allows its own servers" } }
        : support,
    }
  }
}
