import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import {
  addCodexUserMcpLaunchConfig,
  claudeUserMcpEntries,
  type CodexShellPolicyStyle,
  type ResolvedUserMcpServer,
} from '@providers/shared/runtime/userMcpLaunch.js'
import { importUserMcpConfig } from '@shared/userMcp/importConfig.js'
import {
  isUserMcpProvider,
  type NativeMcpServer,
  type NativeMcpServerSource,
  type UserMcpActor,
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
  secretValueProblem,
  userMcpDestination,
  providerSupportForEntry,
  referencedInputIds,
  summarizeEntry,
  transportOf,
  validateServer,
} from '@shared/userMcp/validate.js'

import {
  claudeManagedMcpPolicyPresent,
  codexNativeServerNames,
  codexShellPolicyStyle,
  readNativeMcpServers,
} from './nativeServers.js'
import { UserMcpSecretStore } from './secrets.js'
import { loadUserMcpDocument, saveUserMcpDocument } from './store.js'

type PendingSecretRestore = { run: () => Promise<void>; safeWithNewDocument: boolean }

export type UserMcpLaunchResolution = {
  servers: ResolvedUserMcpServer[]
  attachedIds: string[]
  dropped: UserMcpDroppedServer[]
  /** Codex only: how to send the shell exclusions for the secrets it carries. */
  codexShellPolicy?: CodexShellPolicyStyle
}

export type UserMcpServiceDeps = {
  stateDir: string
  codec: SecretCodec
  /** Injectable for tests; production reads the real CLI config files. */
  native?: {
    list(): Promise<NativeMcpServerSource[]>
    codexNames(cwd: string): Promise<Set<string>>
    claudeManagedPolicy(): Promise<boolean>
    codexShellPolicy?(cwd: string): Promise<CodexShellPolicyStyle>
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
  // Set while the document on disk could not be read (see
  // LoadedUserMcpDocument.readFailed). Writing then would atomically replace
  // every server the user configured with the empty in-memory list, so
  // mutations are refused until a re-read succeeds.
  private readFailed = false

  constructor(deps: UserMcpServiceDeps) {
    this.file = join(deps.stateDir, 'mcp-servers.json')
    this.secrets = new UserMcpSecretStore(join(deps.stateDir, 'mcp-secrets'), deps.codec)
    this.native = deps.native ?? {
      list: () => readNativeMcpServers(),
      codexNames: cwd => codexNativeServerNames(cwd),
      claudeManagedPolicy: () => claudeManagedMcpPolicyPresent(),
      codexShellPolicy: cwd => codexShellPolicyStyle(cwd),
    }
  }

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const loaded = await loadUserMcpDocument(this.file)
      this.document = loaded.document
      this.storeProblem = loaded.problem
      this.readFailed = loaded.readFailed === true
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
      this.native.list().catch(() => [] as NativeMcpServerSource[]),
      this.native.claudeManagedPolicy().catch(() => false),
    ])
    // Names already in the user's own Codex config.toml collide at every Codex
    // launch (see codexNativeServerNames), so the view says so up front.
    // Project-scope files depend on the agent's cwd and are only caught at
    // launch, with a notice.
    const codexNativeNames = new Set(native.filter(entry => entry.provider === 'codex').map(entry => entry.name))
    const claudeNativeNames = new Set(native.filter(entry => entry.provider === 'claude').map(entry => entry.name))
    const servers = await Promise.all(this.document.servers.map(server =>
      this.view(server, claudeManagedPolicy, codexNativeNames, claudeNativeNames)))
    return {
      servers,
      // Strip Copy-in material: see NativeMcpServer.copyable.
      native: native.map(({ entry: _entry, inputs: _inputs, ...view }): NativeMcpServer => view),
      claudeManagedPolicy,
      ...(this.storeProblem ? { storeProblem: this.storeProblem } : {}),
    }
  }

  importConfig(text: string, fallbackName?: string): UserMcpImportResult {
    return importUserMcpConfig(text, fallbackName)
  }

  save(input: UserMcpSaveInput, actor: UserMcpActor = 'user'): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const existing = input.id ? this.document.servers.find(server => server.id === input.id) : undefined
      if (input.id && !existing) return { ok: false, error: 'That server no longer exists.' }
      for (const value of Object.values(input.secrets ?? {})) {
        const problem = value === '' ? null : secretValueProblem(value)
        if (problem) return { ok: false, error: problem }
      }
      const entry = normalizeEntry(input.entry)
      const destinationChanged = existing !== undefined && userMcpDestination(existing.entry) !== userMcpDestination(entry)
      // An agent proposes, the user approves (review round 2): a server an
      // agent adds, or points somewhere new, is stored OFF and flagged for
      // review, and an agent can never turn one on. Otherwise a single
      // prompt-injected agent could install a command that every future agent
      // runs. A user save of an existing server clears the flag only by
      // turning it on (setEnabled); saving it off keeps the flag visible.
      const agentNeedsReview = actor === 'agent' && (existing === undefined || destinationChanged || existing.pendingReview === true)
      const enabled = actor === 'agent'
        ? (agentNeedsReview ? false : existing!.enabled && input.enabled)
        : input.enabled
      const pendingReview = agentNeedsReview || (actor === 'user' && existing?.pendingReview === true && !enabled)
      const server: UserMcpServer = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        enabled,
        providers: { claude: input.providers.claude === true, codex: input.providers.codex === true },
        entry,
        inputs: coerceInputs(input.inputs),
        ...(pendingReview ? { pendingReview: true as const } : {}),
      }
      const others = this.document.servers.filter(other => other.id !== server.id)
      // Structural problems block the save. A missing secret does not: it is a
      // normal intermediate state (paste config now, fetch the token later),
      // and launch already refuses to attach the server until it is set.
      const problems = validateServer(server, others)
      if (problems.length > 0) return { ok: false, error: problems[0]!.message, problems }
      // Changing WHERE a server connects forgets its stored secrets (review
      // round 1). Otherwise an edit — or an agent's mcp_servers_update after a
      // prompt injection — could keep `${input:token}` and point the entry at
      // another host or command, and the next launch would hand the token to
      // it: exfiltration without ever reading a secret. Secrets supplied in
      // this same save are set afterwards, so an intentional move that
      // re-enters the token still works in one step.
      // SECURITY INVARIANT (q110, #1420 review a): a destination is never
      // observable, by a launch or by a restart at any point, paired with a
      // token that was not saved for it. The order below is what holds it:
      //   1. snapshot the server's current secrets (strictly: an unreadable
      //      directory aborts here, before anything changes);
      //   2. on a destination change, CLEAR the old secrets while the old
      //      destination is still the published one, on disk and in memory;
      //   3. only then publish the new document (memory, then disk);
      //   4. write the new secrets and prune.
      // A crash anywhere leaves at worst a server with NO secret: fail closed.
      // The earlier order (document first, then clear) had a window, and a
      // failed rollback made it durable, in which the NEW destination sat on
      // disk with the OLD token, and resolveForLaunch could read it.
      //
      // On failure, mutate() rolls the document back first and restores this
      // snapshot only if the old document is back on disk, or if the
      // destination did not change (then the old secrets still match the
      // document that is on disk). Otherwise the secrets stay cleared.
      const previousSecrets = existing
        ? await this.secrets.snapshotServer(server.id)
        : new Map<string, Buffer>()
      this.pendingSecretRestore = {
        run: () => this.secrets.restoreServer(server.id, previousSecrets),
        safeWithNewDocument: !destinationChanged,
      }
      if (destinationChanged) await this.secrets.clearServer(server.id)
      this.document = {
        version: 1,
        servers: existing
          ? this.document.servers.map(candidate => candidate.id === server.id ? server : candidate)
          : [...this.document.servers, server],
      }
      await this.persist()
      for (const [inputId, value] of Object.entries(input.secrets ?? {})) {
        if (server.inputs.some(candidate => candidate.id === inputId)) {
          await this.secrets.set(server.id, inputId, value)
        }
      }
      await this.secrets.prune(server.id, server.inputs.map(candidate => candidate.id))
      return {
        ok: true,
        id: server.id,
        ...(destinationChanged ? { secretsCleared: true } : {}),
        ...(pendingReview ? { pendingReview: true } : {}),
      }
    })
  }

  delete(id: string): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      if (!this.document.servers.some(server => server.id === id)) return { ok: false, error: 'That server no longer exists.' }
      // Snapshot strictly first (q110), so a failed clear can restore exactly
      // what was there once the document is back (see save()).
      const previousSecrets = await this.secrets.snapshotServer(id)
      this.pendingSecretRestore = {
        run: () => this.secrets.restoreServer(id, previousSecrets),
        safeWithNewDocument: false,
      }
      this.document = { version: 1, servers: this.document.servers.filter(server => server.id !== id) }
      await this.persist()
      await this.secrets.clearServer(id)
      return { ok: true }
    })
  }

  /** Agents may only turn a server OFF; turning one on is the user's review
   * decision, and doing so clears pendingReview. */
  setEnabled(id: string, enabled: boolean, actor: UserMcpActor = 'user'): Promise<UserMcpMutationResult> {
    if (actor === 'agent' && enabled) {
      return Promise.resolve({ ok: false, error: 'Only the user can turn an MCP server on (Settings → MCP).' })
    }
    return this.update(id, server => {
      const { pendingReview: _pending, ...rest } = server
      return enabled ? { ...rest, enabled } : { ...server, enabled }
    })
  }

  setProvider(id: string, provider: UserMcpProvider, enabled: boolean): Promise<UserMcpMutationResult> {
    return this.update(id, server => ({ ...server, providers: { ...server.providers, [provider]: enabled } }))
  }

  setSecret(id: string, inputId: string, value: string): Promise<UserMcpMutationResult> {
    return this.mutate(async () => {
      const problem = value === '' ? null : secretValueProblem(value)
      if (problem) return { ok: false, error: problem }
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
  /**
   * Launch reads are serialized with mutations (q110). Reading
   * `this.document` and the secret store while a save was between its steps
   * could see a half-applied change; now a launch runs strictly before or
   * after each mutation, never inside one.
   */
  resolveForLaunch(params: {
    provider: string
    overrides: Readonly<Record<string, boolean>>
    cwd: string
  }): Promise<UserMcpLaunchResolution> {
    const run = this.tail.then(() => this.resolveForLaunchNow(params))
    this.tail = run.then(() => {}, () => {})
    return run
  }

  private async resolveForLaunchNow(params: {
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
      const support = providerSupportForEntry(server.entry)[provider]
      if (!support.ok) {
        dropped.push({ name: server.name, reason: support.reason })
        continue
      }
      if (claudeManaged) {
        dropped.push({ name: server.name, reason: "Your organization's Claude MCP policy only allows its own servers" })
        continue
      }
      if (server.pendingReview) {
        dropped.push({ name: server.name, reason: 'Waiting for your review in Settings → MCP' })
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
    const codexShellPolicy = provider === 'codex'
      ? await (this.native.codexShellPolicy?.(params.cwd) ?? Promise.resolve({ style: 'filters' } as const))
        .catch(() => ({ style: 'filters' } as const))
      : undefined
    const translatorDrops = provider === 'claude'
      ? claudeUserMcpEntries(candidates).dropped
      // The dry run sees the same inherited environment the Codex process will
      // (Codex inherits main's), so its "your environment already sets X"
      // refusal is reported here rather than silently applied in the session.
      : addCodexUserMcpLaunchConfig(candidates, [], inheritedEnvironment(), codexShellPolicy)
    const refused = new Set(translatorDrops.map(server => server.name))
    dropped.push(...translatorDrops)
    const servers = candidates.filter(server => !refused.has(server.name))
    return {
      servers,
      attachedIds: servers.map(server => server.id),
      dropped,
      ...(codexShellPolicy ? { codexShellPolicy } : {}),
    }
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
    operation: () => Promise<{ ok: true; id?: string; secretsCleared?: boolean; pendingReview?: boolean } | { ok: false; error: string; problems?: UserMcpProblem[] }>,
  ): Promise<UserMcpMutationResult> {
    const run = this.tail.then(async (): Promise<UserMcpMutationResult> => {
      await this.initialize()
      const before = this.document
      if (this.readFailed) {
        // A transient failure (a restore holding the file, EMFILE while many
        // agents start) usually clears; retry before refusing.
        const loaded = await loadUserMcpDocument(this.file)
        if (loaded.readFailed) {
          return { ok: false, error: `${loaded.problem ?? 'MCP settings could not be read'}. Nothing was changed.` }
        }
        this.document = loaded.document
        this.storeProblem = loaded.problem
        this.readFailed = false
      }
      this.persistedInMutation = false
      this.pendingSecretRestore = null
      let outcome: Awaited<ReturnType<typeof operation>>
      try {
        outcome = await operation()
      } catch (error) {
        // Review round 1: a failed persist must not leave memory ahead of
        // disk, or the snapshot shows a server that a restart will lose and a
        // retry is refused as a duplicate. (Secrets written before the failure
        // are orphaned blobs at worst; the next save of that server prunes them.)
        //
        // #1304: operations persist the document BEFORE their secret step
        // (round 2 of that review, so a failed persist cannot lose a token).
        // A secret step that throws after that point used to roll back only
        // memory, leaving disk ahead of it: a saved server came back after a
        // restart without its secret, and a deleted one was written back by
        // the next mutation. Roll the FILE back too. If that write fails as
        // well, disk still holds the new document, so memory keeps it: the
        // two must agree either way.
        let oldDocumentOnDisk: boolean
        if (this.persistedInMutation) {
          try {
            await saveUserMcpDocument(this.file, before)
            this.document = before
            oldDocumentOnDisk = true
          } catch {
            // Disk holds the persisted document; memory already matches it.
            oldDocumentOnDisk = false
          }
        } else {
          this.document = before
          oldDocumentOnDisk = true
        }
        // q110: put the previous secrets back only where they pair with the
        // document that is actually on disk. A restore that itself fails is
        // not retried: the server is left without (some of) its secrets,
        // which launch refuses to attach. That is the fail-closed direction.
        // Read through a method: TypeScript narrows the field to null from the
        // assignment above and cannot see that the operation set it.
        const restore = this.takePendingSecretRestore()
        if (restore && (oldDocumentOnDisk || restore.safeWithNewDocument)) {
          await restore.run().catch(() => {})
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!outcome.ok) return outcome
      // Committed. Nothing after this line may report failure for a change
      // that is on disk (q110, review a finding 4): a listener that threw used
      // to land in the rollback path, which reverted the document but not
      // the secrets it had just written. Each listener is isolated.
      const snapshot = await this.snapshot()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch (error) {
          console.warn('[user-mcp] change listener failed:', error)
        }
      }
      return {
        ok: true,
        snapshot,
        ...(outcome.id ? { id: outcome.id } : {}),
        ...(outcome.secretsCleared ? { secretsCleared: true } : {}),
        ...(outcome.pendingReview ? { pendingReview: true } : {}),
      }
    })
    this.tail = run.catch(() => {})
    return run
  }

  /** The secret restore the current operation registered before touching
   *  secrets (q110); mutate() decides whether it may run. */
  private pendingSecretRestore: PendingSecretRestore | null = null

  private takePendingSecretRestore(): PendingSecretRestore | null {
    const restore = this.pendingSecretRestore
    this.pendingSecretRestore = null
    return restore
  }

  /** Set by persist() during the current mutate() operation (#1304). */
  private persistedInMutation = false

  private async persist(): Promise<void> {
    await saveUserMcpDocument(this.file, this.document)
    this.persistedInMutation = true
    // A successful write supersedes whatever made the old file unreadable.
    this.storeProblem = undefined
  }

  private async view(
    server: UserMcpServer,
    claudeManagedPolicy: boolean,
    codexNativeNames: ReadonlySet<string>,
    claudeNativeNames: ReadonlySet<string>,
  ): Promise<UserMcpServerView> {
    const transport = transportOf(server.entry)
    const others = this.document.servers.filter(other => other.id !== server.id)
    const secrets = await this.secrets.state(server.id, server.inputs.map(input => input.id))
    const problems = validateServer(server, others)
    for (const inputId of referencedInputIds(server.entry)) {
      if (secrets[inputId] && !secrets[inputId]!.set) {
        problems.push({ kind: 'secret-missing', message: `Secret "${inputId}" is not set` })
      }
    }
    if (server.pendingReview) {
      problems.unshift({ kind: 'pending-review', message: 'Added or changed by an agent — review the config, then turn it on' })
    }
    // Spec Decisions: Claude replaces a same-name native server with ours for
    // Agent Code launches (whole-entry --mcp-config precedence), while the
    // user's own `claude` runs keep theirs. Say so, or a rotated native token
    // looks ignored (review round 2).
    if (claudeNativeNames.has(server.name) && server.providers.claude) {
      problems.push({ kind: 'claude-native-name', message: 'Also in your Claude config; Agent Code agents use this one instead' })
    }
    const support = { ...providerSupportForEntry(server.entry) }
    if (claudeManagedPolicy) {
      support.claude = { ok: false, reason: "Your organization's Claude MCP policy only allows its own servers" }
    }
    if (support.codex.ok && codexNativeNames.has(server.name)) {
      support.codex = { ok: false, reason: 'A server with this name is already in your Codex config.toml' }
    }
    return {
      ...server,
      transport,
      summary: summarizeEntry(server.entry),
      secrets,
      problems,
      support,
    }
  }
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
