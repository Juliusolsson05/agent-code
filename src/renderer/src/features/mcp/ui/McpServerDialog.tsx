import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { applyUserMcpResult, useUserMcpSnapshot } from '@renderer/features/mcp/store'
import { Check } from '@renderer/features/mcp/ui/McpServersRow'
import type {
  UserMcpImportCandidate,
  UserMcpInput,
  UserMcpProvider,
  UserMcpServerEntry,
  UserMcpServerView,
} from '@shared/userMcp/types'
import { USER_MCP_PROVIDERS } from '@shared/userMcp/types'
import { providerSupportForEntry, transportOf, userMcpDestination } from '@shared/userMcp/validate'

const PROVIDER_LABEL: Record<UserMcpProvider, string> = { claude: 'Claude', codex: 'Codex' }

/**
 * Add / Edit MCP server (#1143). Paste-first on purpose: "any MCP server"
 * means any shape a README publishes, and a field-by-field form would either
 * restrict that or grow a field for every transport option ever invented. The
 * JSON the user edits IS the stored entry; secrets are the only thing pulled
 * out, into masked fields, because they are the only thing that must never be
 * written to disk in the clear.
 *
 * Validation is main's (UserMcpService.save / validateServer). The dialog only
 * pre-parses JSON so a typo is flagged while typing instead of on Save.
 */
export function McpServerDialog() {
  const target = useAppStore(state => state.mcpServerDialog)
  const close = useAppStore(state => state.closeMcpServerDialog)
  const snapshot = useUserMcpSnapshot()
  const editing = target?.mode === 'edit'
    ? snapshot?.servers.find(server => server.id === target.serverId) ?? null
    : null
  // A pasted or edited config is REAL typed input (B7's condition on plan
  // D3): Escape, an outside click and Cancel all route through requestClose,
  // which asks before discarding it. The child reports its dirtiness through
  // a ref because only it knows what "unchanged" means (empty paste vs the
  // opened entry), and a ref keeps that report from re-rendering the host.
  const dirtyRef = useRef(false)
  // In-flight persistence holds the dialog (steering note k5, the k3 rule):
  // Add saves several servers one by one and Edit awaits main's verdict, so
  // closing mid-save would hide partial success or a failure. Every close
  // path — Escape, outside click, Cancel — funnels through requestClose.
  const savingRef = useRef(false)
  const requestClose = async () => {
    if (savingRef.current) return
    if (dirtyRef.current && !(await requestConfirm({
      title: 'Discard this MCP server config?',
      description: 'What you pasted or edited here will be lost.',
      confirmLabel: 'Discard Changes',
      tone: 'danger',
    }))) return
    dirtyRef.current = false
    close()
  }
  const reportDirty = (dirty: boolean) => { dirtyRef.current = dirty }
  const reportSaving = (saving: boolean) => { savingRef.current = saving }

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open) void requestClose() }}>
      {/* size md: the old `max-w-2xl` was a no-op against the base 520px
          width, so this dialog rendered narrower than its author intended
          (plan T2). */}
      <DialogContent size="md">
        {target?.mode === 'add' ? <AddServer onDone={close} onCancel={() => void requestClose()} onDirty={reportDirty} onSaving={reportSaving} /> : null}
        {target?.mode === 'edit' && editing ? <EditServer key={editing.id} server={editing} onDone={close} onCancel={() => void requestClose()} onDirty={reportDirty} onSaving={reportSaving} /> : null}
        {target?.mode === 'edit' && !editing ? (
          <DialogHeader>
            <DialogTitle>Server not found</DialogTitle>
            <DialogDescription>It may have been deleted in another window.</DialogDescription>
          </DialogHeader>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type Draft = {
  include: boolean
  name: string
  providers: Record<UserMcpProvider, boolean>
  secrets: Record<string, string>
}

function AddServer({ onDone, onCancel, onDirty, onSaving }: { onDone: () => void; onCancel: () => void; onDirty: (dirty: boolean) => void; onSaving: (saving: boolean) => void }) {
  const [text, setText] = useState('')
  useEffect(() => { onDirty(text.trim().length > 0) }, [onDirty, text])
  const [candidates, setCandidates] = useState<UserMcpImportCandidate[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { onSaving(saving) }, [onSaving, saving])
  // True from a keystroke until main answers for that text. Add is refused
  // meanwhile so it can never save a parse of text the user already changed
  // (review round 1: a token deleted from the box was still saved).
  const [parsing, setParsing] = useState(false)
  // Servers already saved in this dialog, keyed by the name the PARSE gave
  // them. A multi-server paste is saved one server at a time; after a partial
  // failure the retry must continue with the rest instead of re-adding the
  // first one and failing as a duplicate. Keyed by parse name, not index
  // (review round 2), so editing the paste box afterwards does not forget it.
  const [savedKeys, setSavedKeys] = useState<ReadonlySet<string>>(new Set())
  // The previous parse and the user's edits to it, read when a new parse
  // lands so a re-parse refreshes the entries without discarding secrets,
  // names or provider choices the user already typed (review round 2).
  const previous = useRef<{ candidates: UserMcpImportCandidate[]; drafts: Draft[] }>({ candidates: [], drafts: [] })
  previous.current = { candidates, drafts }
  // The sanitized text we put in the box ourselves, which must not be
  // re-imported (it no longer contains the lifted values).
  const [sanitizedText, setSanitizedText] = useState<string | null>(null)

  // Parsing runs in main (the same importer Copy in and tests use) so there is
  // exactly one definition of what a pasted snippet means. Debounced because
  // every keystroke would otherwise be an IPC round-trip. A bare entry is
  // imported as "server" and renamed on its card: a separate name field that
  // re-imported on every keystroke wiped secrets typed into the card.
  useEffect(() => {
    if (text === sanitizedText) {
      // Back on our own sanitized snapshot (e.g. undo): the cards on screen
      // are still the ones to save, and any in-flight parse was cancelled.
      setParsing(false)
      return
    }
    if (!text.trim()) {
      setCandidates([])
      setDrafts([])
      setParseError(null)
      setParsing(false)
      return
    }
    setParsing(true)
    let cancelled = false
    const timer = setTimeout(() => {
      window.api.userMcpImport(text).then(result => {
        if (cancelled) return
        setParsing(false)
        if (!result.ok) {
          setParseError(result.error)
          setCandidates([])
          setDrafts([])
          return
        }
        setParseError(null)
        const before = previous.current
        setCandidates(result.candidates)
        setDrafts(result.candidates.map(candidate => {
          const support = providerSupportForEntry(candidate.entry)
          const fresh: Draft = {
            include: true,
            name: candidate.name,
            providers: { claude: support.claude.ok, codex: support.codex.ok },
            secrets: { ...candidate.pendingSecrets },
          }
          const index = before.candidates.findIndex(old => old.name === candidate.name)
          const old = index >= 0 ? before.drafts[index] : undefined
          if (!old) return fresh
          const stillReferenced = new Set(candidate.inputs.map(input => input.id))
          return {
            include: old.include,
            name: old.name,
            providers: {
              claude: old.providers.claude && support.claude.ok,
              codex: old.providers.codex && support.codex.ok,
            },
            // Values typed or lifted earlier survive for every secret the new
            // parse still references; a value pasted literally again wins.
            secrets: {
              ...Object.fromEntries(Object.entries(old.secrets).filter(([id]) => stillReferenced.has(id))),
              ...candidate.pendingSecrets,
            },
          }
        }))
        // Review round 1: once a value has been lifted into a masked secret
        // field, the raw paste must not keep showing it. The box now shows
        // what will be stored — references only.
        if (result.candidates.some(candidate => Object.keys(candidate.pendingSecrets).length > 0)) {
          const sanitized = JSON.stringify(
            { mcpServers: Object.fromEntries(result.candidates.map(candidate => [candidate.name, candidate.entry])) },
            null,
            2,
          )
          setSanitizedText(sanitized)
          setText(sanitized)
        }
      }).catch(error => {
        if (cancelled) return
        setParsing(false)
        setParseError(error instanceof Error ? error.message : String(error))
        setCandidates([])
        setDrafts([])
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, sanitizedText])

  const isSaved = (index: number) => savedKeys.has(candidates[index]?.name ?? '')
  const pending = drafts.filter((draft, index) => draft.include && !isSaved(index)).length
  const save = async () => {
    if (parsing) return
    setSaving(true)
    setSaveError(null)
    try {
      for (const [index, candidate] of candidates.entries()) {
        const draft = drafts[index]!
        if (!draft.include || isSaved(index)) continue
        const result = await window.api.userMcpSave({
          name: draft.name,
          enabled: true,
          providers: draft.providers,
          entry: candidate.entry,
          inputs: candidate.inputs,
          secrets: draft.secrets,
        })
        const error = applyUserMcpResult(result)
        if (error) {
          setSaveError(`${draft.name}: ${error}`)
          return
        }
        setSavedKeys(current => new Set([...current, candidate.name]))
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add MCP server</DialogTitle>
        <DialogDescription>
          Paste the config from the server&apos;s README. mcpServers blocks, VS Code servers/inputs and single entries all work.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-4 py-3 text-[11px]">
        <Textarea
          autoFocus
          value={text}
          disabled={saving}
          onChange={event => setText(event.target.value)}
          spellCheck={false}
          className="h-40 font-code text-[11px]"
          placeholder={'{\n  "mcpServers": {\n    "beeper": { "url": "http://localhost:23373/v0/mcp" }\n  }\n}'}
          aria-label="MCP server config"
        />
        {parseError ? <div className="text-danger">{parseError}</div> : null}
        {candidates.map((candidate, index) => isSaved(index) ? (
          <div key={`${candidate.name}:${index}`} className="rounded-slab border border-border px-3 py-2 text-muted">
            ✓ {drafts[index]!.name} added
          </div>
        ) : (
          <CandidateCard
            key={`${candidate.name}:${index}`}
            candidate={candidate}
            draft={drafts[index]!}
            multiple={candidates.length > 1}
            onChange={draft => setDrafts(current => current.map((item, i) => i === index ? draft : item))}
          />
        ))}
        {candidates.length > 0 ? (
          <div className="text-[10px] text-muted">
            Values from env and headers are stored as encrypted secrets, never in the config file. They reach the server through environment variables, not the command line.
          </div>
        ) : null}
        {saveError ? <div className="text-danger">{saveError}</div> : null}
      </div>
      {/* ⌘↩ adds (the config textarea owns plain Enter). Guards carried
          over (k3): Add waits for saving/parsing and a parsed candidate. */}
      <DialogActions
        confirmLabel={pending > 1 ? `Add ${pending} Servers` : 'Add Server'}
        confirmKey="Cmd+Enter"
        confirmDisabled={saving || parsing || pending === 0}
        onConfirm={() => void save()}
        onCancel={onCancel}
        cancelDisabled={saving}
        escapeCancels={!saving}
      />
    </>
  )
}

function CandidateCard({
  candidate,
  draft,
  multiple,
  onChange,
}: {
  candidate: UserMcpImportCandidate
  draft: Draft
  multiple: boolean
  onChange: (draft: Draft) => void
}) {
  const transport = transportOf(candidate.entry)
  const support = providerSupportForEntry(candidate.entry)
  // Problems about the name are re-evaluated by main on save; the name field
  // here is editable precisely so a reserved or duplicate name can be fixed.
  const entryProblems = candidate.problems.filter(problem => !['invalid-name', 'reserved-name', 'duplicate-name'].includes(problem.kind))
  return (
    <div className="rounded-slab border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        {multiple ? (
          <Check checked={draft.include} label={`Add ${draft.name}`} onChange={include => onChange({ ...draft, include })} />
        ) : null}
        <Input value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} className="h-7 w-48" aria-label="Server name" />
        <span className="text-muted">{transport ?? 'unknown transport'}</span>
        <span className="ml-auto flex items-center gap-3">
          {USER_MCP_PROVIDERS.map(provider => (
            <label key={provider} className="flex items-center gap-1">
              <Check
                checked={draft.providers[provider]}
                disabled={!support[provider].ok}
                label={`Attach to ${PROVIDER_LABEL[provider]}`}
                onChange={on => onChange({ ...draft, providers: { ...draft.providers, [provider]: on } })}
              />
              {PROVIDER_LABEL[provider]}
            </label>
          ))}
        </span>
      </div>
      <UnsupportedProviderNotes support={support} />
      {entryProblems.map(problem => <div key={problem.message} className="mt-1 text-warning">⚠ {problem.message}</div>)}
      {candidate.inputs.length > 0 ? (
        <SecretFields
          inputs={candidate.inputs}
          values={draft.secrets}
          states={Object.fromEntries(candidate.inputs.map(input => [input.id, { set: draft.secrets[input.id] !== undefined }]))}
          onChange={secrets => onChange({ ...draft, secrets })}
        />
      ) : null}
    </div>
  )
}

/** What another window or an agent could change under an open editor. */
function editableFingerprint(server: UserMcpServerView): string {
  return JSON.stringify([server.name, server.enabled, server.providers, server.entry, server.inputs])
}

function EditServer({ server, onDone, onCancel, onDirty, onSaving }: { server: UserMcpServerView; onDone: () => void; onCancel: () => void; onDirty: (dirty: boolean) => void; onSaving: (saving: boolean) => void }) {
  // Review round 1: the form is initialized once, but `server` keeps updating
  // from the broadcast. Saving a form opened before another window (or an
  // agent with MCP Servers) changed the same server would write the old entry
  // back and prune any secret added since. The fingerprint at open time lets
  // Save refuse instead.
  const [openedAs] = useState(() => editableFingerprint(server))
  const changedElsewhere = editableFingerprint(server) !== openedAs
  const [name, setName] = useState(server.name)
  const [openedJson] = useState(() => JSON.stringify(server.entry, null, 2))
  const [json, setJson] = useState(openedJson)
  const [providers, setProviders] = useState(server.providers)
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({})
  // Dirty = any local change, SECRETS INCLUDED (steering note k5: a
  // secret-only edit was discarded by Escape without asking). SecretFields
  // keeps a key only while its field holds an edit — typing then emptying a
  // field deletes the key (a revert, not a change), while an explicit Clear
  // stores '' (a real change: it will delete the stored secret).
  useEffect(() => {
    onDirty(
      json !== openedJson
      || name !== server.name
      || JSON.stringify(providers) !== JSON.stringify(server.providers)
      || Object.keys(secretEdits).length > 0,
    )
  }, [json, name, onDirty, openedJson, providers, secretEdits, server.name, server.providers])
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => { onSaving(saving) }, [onSaving, saving])

  const parsed = useMemo((): { entry: UserMcpServerEntry | null; error: string | null } => {
    try {
      const value: unknown = JSON.parse(json)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { entry: null, error: 'The config must be a JSON object.' }
      return { entry: value as UserMcpServerEntry, error: null }
    } catch (cause) {
      return { entry: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [json])

  // Secret definitions follow the JSON: typing `${input:new-token}` into a
  // header creates a field for it, and removing the last reference drops it
  // (main prunes the orphaned blob on save). Existing descriptions are kept.
  const inputs = useMemo((): UserMcpInput[] => {
    const ids = [...new Set([...json.matchAll(/\$\{input:([A-Za-z0-9_-]{1,64})\}/g)].map(match => match[1]!))]
    return ids.map(id => server.inputs.find(input => input.id === id) ?? { id, description: 'Secret' })
  }, [json, server.inputs])

  const transport = parsed.entry ? transportOf(parsed.entry) : null
  const support = providerSupportForEntry(parsed.entry)
  // Saving a changed destination forgets the stored secrets (service.save).
  // Say so where the secrets are, and show them as not set, instead of a
  // placeholder claiming they are (review round 2).
  const destinationChanged = parsed.entry !== null && userMcpDestination(parsed.entry) !== userMcpDestination(server.entry)
  const secretStates = destinationChanged
    ? Object.fromEntries(inputs.map(input => [input.id, { set: false }]))
    : server.secrets

  const save = async () => {
    if (!parsed.entry || changedElsewhere) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.userMcpSave({
        id: server.id,
        name,
        enabled: server.enabled,
        providers: {
          claude: providers.claude && support.claude.ok,
          codex: providers.codex && support.codex.ok,
        },
        entry: parsed.entry,
        inputs,
        secrets: secretEdits,
      })
      const failure = applyUserMcpResult(result)
      if (failure) setError(failure)
      else onDone()
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    const failure = applyUserMcpResult(await window.api.userMcpDelete(server.id))
    if (failure) setError(failure)
    else onDone()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit MCP server</DialogTitle>
        <DialogDescription>Changes apply to new agents, and to existing agents when they reload.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-4 py-3 text-[11px]">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-muted">Name</span>
            <Input value={name} onChange={event => setName(event.target.value)} className="h-7 w-48" />
          </label>
          <span className="text-muted">Transport: {transport ?? '—'}</span>
          <span className="ml-auto flex items-center gap-3">
            {USER_MCP_PROVIDERS.map(provider => (
              <label key={provider} className="flex items-center gap-1">
                <Check
                  checked={providers[provider] && support[provider].ok}
                  disabled={!support[provider].ok}
                  label={`Attach to ${PROVIDER_LABEL[provider]}`}
                  onChange={on => setProviders(current => ({ ...current, [provider]: on }))}
                />
                {PROVIDER_LABEL[provider]}
              </label>
            ))}
          </span>
        </div>
        <UnsupportedProviderNotes support={support} />
        <Textarea
          value={json}
          onChange={event => setJson(event.target.value)}
          spellCheck={false}
          className="h-44 font-code text-[11px]"
          aria-label="Server config"
        />
        {parsed.error ? <div className="text-danger">{parsed.error}</div> : null}
        {inputs.length > 0 ? (
          <SecretFields
            inputs={inputs}
            values={secretEdits}
            states={secretStates}
            onChange={setSecretEdits}
          />
        ) : null}
        {destinationChanged && inputs.length > 0 ? (
          <div className="text-warning">
            This changes where the server connects, so its stored secrets will be forgotten. Re-enter them above to keep them.
          </div>
        ) : null}
        {server.transport === 'http' || server.transport === 'sse'
          ? <SignInHelp name={server.name} url={String((server.entry as { url?: unknown }).url ?? '')} />
          : null}
        {error ? <div className="text-danger">{error}</div> : null}
        {changedElsewhere ? (
          <div className="text-warning">
            This server was changed in another window or by an agent. Close and reopen it to edit the current version.
          </div>
        ) : null}

      </div>
      {/* ⌘↩ saves (the config textarea owns plain Enter). Delete stays a
          deliberate two-step at the far left — never a key. Guards carried
          over (k3): Save waits for saving, a parsed entry and no remote
          change. */}
      <DialogActions
        confirmLabel="Save"
        confirmKey="Cmd+Enter"
        confirmDisabled={saving || !parsed.entry || changedElsewhere}
        onConfirm={() => void save()}
        onCancel={onCancel}
        cancelDisabled={saving}
        escapeCancels={!saving}
        extraActions={confirmDelete ? (
          <Button variant="destructive" size="sm" className="mr-auto" onClick={() => void remove()}>Delete {server.name}</Button>
        ) : (
          <Button variant="destructive-outline" size="sm" className="mr-auto" onClick={() => setConfirmDelete(true)}>Delete…</Button>
        )}
      />
    </>
  )
}

function SecretFields({
  inputs,
  values,
  states,
  onChange,
}: {
  inputs: UserMcpInput[]
  values: Record<string, string>
  states: Record<string, { set: boolean; hint?: string }>
  onChange: (values: Record<string, string>) => void
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">Secrets</div>
      {inputs.map(input => {
        const state = states[input.id]
        const edited = values[input.id]
        const placeholder = edited === ''
          ? 'cleared on save'
          : state?.set
          ? `set${state.hint ? ` (…${state.hint})` : ''} — type to replace`
          : 'not set'
        return (
          <label key={input.id} className="flex items-center gap-2">
            <span className="w-48 shrink-0 truncate font-code text-[10px] text-ink" title={input.description}>{input.id}</span>
            <Input
              type="password"
              autoComplete="off"
              value={edited ?? ''}
              placeholder={placeholder}
              onChange={event => {
                // An emptied field means "leave it as it was", never "delete"
                // (review round 1): typing then backspacing looked untouched
                // but sent '' and erased the stored secret. Only Clear deletes.
                const next = { ...values }
                if (event.target.value === '') delete next[input.id]
                else next[input.id] = event.target.value
                onChange(next)
              }}
              className="h-7 flex-1"
              aria-label={`Secret ${input.id}`}
            />
            {state?.set && edited === undefined ? (
              <Button size="xs" variant="ghost" onClick={() => onChange({ ...values, [input.id]: '' })}>Clear</Button>
            ) : null}
            {edited === '' ? <span className="text-[10px] text-warning">will be cleared</span> : null}
          </label>
        )
      })}
    </div>
  )
}

/**
 * OAuth stays with each CLI (spec Decisions: "OAuth delegated"). Both store
 * tokens in the OS keychain keyed on a server identity our launch keeps stable,
 * so a login done here is reused by every later agent. We show the exact
 * commands rather than running them: login opens a browser and waits on the
 * user, which belongs in a terminal the user controls.
 */
function SignInHelp({ name, url }: { name: string; url: string }) {
  // Built from the SAVED server (not the fields being edited) and every
  // interpolated piece single-quoted for the shell (review round 1): a URL may
  // legally contain `'`, and an unquoted piece would run `$(…)` when the user
  // pastes the command. Names are already restricted to [A-Za-z0-9_-].
  const codexCommand = ['codex', 'mcp', 'login', name, '-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`]
    .map(shellQuote)
    .join(' ')
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-slab border border-border px-3 py-2 text-[10px] text-muted">
      <div className="mb-1 uppercase tracking-wider">Sign in (OAuth servers)</div>
      <div>Servers that use OAuth instead of a token sign in through each CLI. This uses the SAVED name and URL — save your changes first:</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="shrink-0">Codex:</span>
        <code className="min-w-0 flex-1 break-all font-code text-ink">{codexCommand}</code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(codexCommand).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-1">Claude: run <code className="font-code text-ink">/mcp</code> in an agent that has {name} attached, then choose Authenticate.</div>
    </div>
  )
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Why a provider's checkbox is locked, as VISIBLE text (K2-11).
 *
 * The reason ("Codex cannot pass a secret named GITHUB_TOKEN", "… does not
 * support this transport") lived only in the label's hover `title`, and a
 * disabled checkbox is out of the Tab order. So a keyboard or screen reader
 * user met a locked control with no reachable explanation at all, and a mouse
 * user had to find it by hovering. It is the answer to "why can't I attach
 * this here?", so it is shown under the row for everyone.
 */
function UnsupportedProviderNotes({ support }: { support: ReturnType<typeof providerSupportForEntry> }) {
  const notes = USER_MCP_PROVIDERS.flatMap(provider => {
    const entry = support[provider]
    return entry.ok ? [] : [{ provider, reason: entry.reason }]
  })
  if (notes.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-muted">
      {notes.map(note => (
        <li key={note.provider}>
          {PROVIDER_LABEL[note.provider]} not available: {note.reason}
        </li>
      ))}
    </ul>
  )
}
