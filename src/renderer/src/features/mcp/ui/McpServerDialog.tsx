import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
import { providerSupport, transportOf } from '@shared/userMcp/validate'

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

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open) close() }}>
      <DialogContent className="max-w-2xl">
        {target?.mode === 'add' ? <AddServer onDone={close} /> : null}
        {target?.mode === 'edit' && editing ? <EditServer key={editing.id} server={editing} onDone={close} /> : null}
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

function AddServer({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('')
  const [fallbackName, setFallbackName] = useState('server')
  const [candidates, setCandidates] = useState<UserMcpImportCandidate[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [format, setFormat] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Parsing runs in main (the same importer Copy in and tests use) so there is
  // exactly one definition of what a pasted snippet means. Debounced because
  // every keystroke would otherwise be an IPC round-trip.
  useEffect(() => {
    if (!text.trim()) {
      setCandidates([])
      setDrafts([])
      setParseError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.userMcpImport(text, fallbackName).then(result => {
        if (cancelled) return
        if (!result.ok) {
          setParseError(result.error)
          setCandidates([])
          setDrafts([])
          return
        }
        setParseError(null)
        setFormat(result.format)
        setCandidates(result.candidates)
        setDrafts(result.candidates.map(candidate => {
          const support = providerSupport(transportOf(candidate.entry))
          return {
            include: true,
            name: candidate.name,
            providers: { claude: support.claude.ok, codex: support.codex.ok },
            secrets: { ...candidate.pendingSecrets },
          }
        }))
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, fallbackName])

  const selected = drafts.filter(draft => draft.include).length
  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const [index, candidate] of candidates.entries()) {
        const draft = drafts[index]!
        if (!draft.include) continue
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
          onChange={event => setText(event.target.value)}
          spellCheck={false}
          className="h-40 font-code text-[11px]"
          placeholder={'{\n  "mcpServers": {\n    "beeper": { "url": "http://localhost:23373/v0/mcp" }\n  }\n}'}
          aria-label="MCP server config"
        />
        {parseError ? <div className="text-danger">{parseError}</div> : null}
        {format === 'entry' ? (
          <label className="flex items-center gap-2">
            <span className="text-muted">Name</span>
            <Input value={fallbackName} onChange={event => setFallbackName(event.target.value)} className="h-7 w-48" />
          </label>
        ) : null}
        {candidates.map((candidate, index) => (
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
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={saving || selected === 0} onClick={() => void save()}>
          {selected > 1 ? `Add ${selected} servers` : 'Add server'}
        </Button>
      </DialogFooter>
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
  const support = providerSupport(transport)
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
            <label key={provider} className="flex items-center gap-1" title={support[provider].ok ? undefined : support[provider].reason}>
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

function EditServer({ server, onDone }: { server: UserMcpServerView; onDone: () => void }) {
  const [name, setName] = useState(server.name)
  const [json, setJson] = useState(() => JSON.stringify(server.entry, null, 2))
  const [providers, setProviders] = useState(server.providers)
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

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
  const support = providerSupport(transport)

  const save = async () => {
    if (!parsed.entry) return
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
              <label key={provider} className="flex items-center gap-1" title={support[provider].ok ? undefined : support[provider].reason}>
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
            states={server.secrets}
            onChange={setSecretEdits}
          />
        ) : null}
        {transport === 'http' || transport === 'sse' ? <SignInHelp name={name} url={String((parsed.entry as { url?: unknown } | null)?.url ?? '')} /> : null}
        {error ? <div className="text-danger">{error}</div> : null}
      </div>
      <DialogFooter>
        {confirmDelete ? (
          <Button variant="destructive" onClick={() => void remove()}>Delete {server.name}</Button>
        ) : (
          <Button variant="destructive-outline" onClick={() => setConfirmDelete(true)}>Delete…</Button>
        )}
        <span className="flex-1" />
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={saving || !parsed.entry} onClick={() => void save()}>Save</Button>
      </DialogFooter>
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
        const placeholder = state?.set
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
              onChange={event => onChange({ ...values, [input.id]: event.target.value })}
              className="h-7 flex-1"
              aria-label={`Secret ${input.id}`}
            />
            {state?.set && edited === undefined ? (
              <Button size="xs" variant="ghost" onClick={() => onChange({ ...values, [input.id]: '' })}>Clear</Button>
            ) : null}
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
  const codexCommand = `codex mcp login ${name} -c 'mcp_servers.${name}.url=${JSON.stringify(url)}'`
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-slab border border-border px-3 py-2 text-[10px] text-muted">
      <div className="mb-1 uppercase tracking-wider">Sign in (OAuth servers)</div>
      <div>Servers that use OAuth instead of a token sign in through each CLI:</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="shrink-0">Codex:</span>
        <code className="min-w-0 flex-1 truncate font-code text-ink">{codexCommand}</code>
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
