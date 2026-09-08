import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useAppStore } from '@renderer/app-state/hooks'
import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'
import type { KeyVaultKey, KeyVaultStatus } from '@shared/types/keyVault'

// API Key Vault modal (#831). Revealed plaintext lives only in this
// component's ephemeral state — the VAULT never persists it — and is
// cleared on lock/close/deletion. Metadata flows through the
// window.api.keyVault* calls; every secret fetch crosses the main-side
// unlock gate (one OS prompt per app run), so "Reveal" on a locked vault
// is what triggers Touch ID / the login-password prompt.
//
// DISCLOSURE (review finding): once a key is INSERTED, it leaves the
// vault's protection by design — a composer draft autosaves to
// workspace.json in plaintext until sent or cleared, and a PTY paste
// lands in scrollback/tmux history. Submitting the prompt puts the key
// in the provider transcript, plaintext, exactly like a manual paste.
// The vault encrypts STORAGE, not the prompt pipeline.

type KeyForm = { id?: string; name: string; value: string; note: string } | null

export function KeyVaultModal() {
  const closeKeyVault = useAppStore(state => state.closeKeyVault)
  // Only App owns useWorkspace(): mounting another controller here would
  // duplicate recovery, subscriptions and persistence every time the vault opens.
  const workspace = useWorkspaceLayoutContext()
  const targetSessionId = useRef(commandTargetSessionId(workspace))
  const generation = useRef(0)
  const mounted = useRef(true)
  const actionInFlight = useRef(false)
  const [status, setStatus] = useState<KeyVaultStatus | null>(null)
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [keys, setKeys] = useState<KeyVaultKey[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  // keyId -> revealed plaintext. Ephemeral by design; never persisted.
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map())
  const [newProviderName, setNewProviderName] = useState('')
  // Inline rename (review finding): window.prompt does not exist in
  // Electron — it throws — so Rename lived in a dead click handler. An
  // inline input row follows the same pattern as "New provider…".
  const [providerRename, setProviderRename] = useState<{ id: string; name: string } | null>(null)
  const [keyForm, setKeyForm] = useState<KeyForm>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const started = generation.current
    try {
      await window.api.keyVaultUnlock()
      if (!mounted.current || started !== generation.current) return
      const [nextStatus, snapshot] = await Promise.all([
        window.api.keyVaultStatus(),
        window.api.keyVaultList(),
      ])
      if (!mounted.current || started !== generation.current) return
      setStatus(nextStatus)
      setProviders(snapshot.providers)
      setKeys(snapshot.keys)
      // Never keep plaintext for metadata that just disappeared (key or
      // provider deleted elsewhere in the modal while revealed).
      setRevealed(prev => {
        const live = new Set(snapshot.keys.map(k => k.id))
        let changed = false
        for (const id of prev.keys()) if (!live.has(id)) changed = true
        return changed ? new Map([...prev].filter(([id]) => live.has(id))) : prev
      })
      setSelectedProviderId(current => {
        if (current && snapshot.providers.some(p => p.id === current)) return current
        return snapshot.providers[0]?.id ?? null
      })
      setError(null)
    } catch (err) {
      if (!mounted.current || started !== generation.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const clearSecrets = useCallback(() => {
    generation.current += 1
    setRevealed(new Map())
    setKeyForm(null)
    setStatus(prev => prev ? { ...prev, unlocked: false } : prev)
  }, [])

  useEffect(() => {
    mounted.current = true
    const off = window.api.onKeyVaultLocked(clearSecrets)
    void refresh()
    return () => { mounted.current = false; generation.current += 1; off() }
  }, [refresh, clearSecrets])

  const runVaultAction = async (action: () => Promise<void>) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    const started = generation.current
    try {
      await action()
      if (!mounted.current || started !== generation.current) return
      await refresh()
    } catch (err) {
      // Canceled OS prompt, fail-closed gate, duplicate name, … — the
      // service messages are written for direct display.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      actionInFlight.current = false
    }
  }

  const addProvider = () => {
    const name = newProviderName.trim()
    if (!name) return
    setNewProviderName('')
    void runVaultAction(() => window.api.keyVaultCreateProvider(name))
  }

  const saveKeyForm = () => {
    const form = keyForm
    if (!form || !selectedProviderId) return
    const started = generation.current
    void runVaultAction(async () => {
      await window.api.keyVaultPutKey({
      providerId: selectedProviderId,
      id: form.id,
      name: form.name,
      value: form.value,
      note: form.note,
      })
      if (mounted.current && generation.current === started) {
        setKeyForm(current => current === form ? null : current)
        setRevealed(new Map())
      }
    })
  }

  const toggleReveal = async (key: KeyVaultKey) => {
    const started = generation.current
    if (revealed.has(key.id)) {
      const next = new Map(revealed)
      next.delete(key.id)
      setRevealed(next)
      return
    }
    if (actionInFlight.current) return
    actionInFlight.current = true
    try {
      const value = await window.api.keyVaultReveal(key.providerId, key.id)
      if (!mounted.current || started !== generation.current) return
      setRevealed(prev => new Map(prev).set(key.id, value))
      setStatus(prev => (prev ? { ...prev, unlocked: true } : prev))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      actionInFlight.current = false
    }
  }

  const insertKey = async (key: KeyVaultKey) => {
    const started = generation.current
    const sessionId = targetSessionId.current
    if (!sessionId) {
      setError('No focused pane to insert into')
      return
    }
    if (actionInFlight.current) return
    actionInFlight.current = true
    const owner = workspace.state.sessions[sessionId]
    try {
      // A display cache is not authorization; always re-enter the main gate.
      const value = await window.api.keyVaultReveal(key.providerId, key.id)
      if (!mounted.current || started !== generation.current) return
      if (useAppStore.getState().workspaceState.sessions[sessionId] !== owner) {
        throw new Error('Target pane changed while unlocking. Close the vault and choose the pane again.')
      }
      const result = await deliverTextToSession(workspace, sessionId, value, {
        isCurrent: () => mounted.current && started === generation.current &&
          useAppStore.getState().workspaceState.sessions[sessionId] === owner,
      })
      if (result.delivered) {
        workspace.showPaneToast(sessionId, `Inserted key: ${key.name}`)
        closeKeyVault()
      } else if (result.reason === 'write-rejected') {
        setError('Terminal write was rejected — pane is not ready; try again')
      } else {
        setError('Focused pane is no longer available')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      actionInFlight.current = false
    }
  }

  const selectedKeys = keys.filter(k => k.providerId === selectedProviderId)
  const selectedProvider = providers.find(p => p.id === selectedProviderId) ?? null

  return (
    <Dialog open onOpenChange={nextOpen => { if (!nextOpen) closeKeyVault() }}>
      <DialogContent className="flex max-h-[85vh] w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden">
        {/* `flex` has to accompany `flex-row` here. DialogHeader's base class
            list is a plain block, so flex-row/items-center/justify-between
            were all inert and "Lock now" stacked underneath the description
            instead of sitting opposite the title. */}
        <DialogHeader className="flex flex-row items-center justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle className="font-semibold">API Key Vault</DialogTitle>
            <DialogDescription className="mt-0.5 text-[10px]">
              {status
                ? status.unlocked
                  ? 'unlocked for this app launch'
                  : 'locked — revealing a key prompts once per launch'
                : '…'}
            </DialogDescription>
          </div>
          {status?.unlocked && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => {
                // Clear visible plaintext BEFORE locking: a "locked"
                // status line over revealed secrets was a review finding.
                clearSecrets()
                void window.api.keyVaultLock().catch(err => setError(err instanceof Error ? err.message : 'Could not lock vault'))
              }}
            >
              Lock now
            </Button>
          )}
        </DialogHeader>

        {/* DialogContent carries NO padding by design — DialogHeader and
            DialogFooter own their own px-4 py-3 and every feature modal pads
            its own body (see ViewPromptsModal / RewindToPromptModal). This
            wrapper is that body. Without it the provider list, key rows and
            footnote rendered flush against the dialog border on all four
            sides, which is exactly how this shipped. */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
          {status && !status.encryptionAvailable && (
            <div className="rounded-slab border border-border bg-canvas px-2 py-1 text-[11px] text-ink">
              OS keyring (safeStorage) is unavailable on this machine — keys cannot be stored.
            </div>
          )}
          {error && (
            <div className="rounded-slab border border-border bg-canvas px-2 py-1 text-[11px] text-ink">
              {error}
            </div>
          )}

          {!status?.unlocked && (
            <Button className="self-start" onClick={() => void refresh()}>
              Unlock Vault
            </Button>
          )}

          {/* Only the two columns scroll. Scrolling the ROW as well (as it did)
              meant the provider list slid out of view with the key list and
              produced a second nested scrollbar on the same axis. */}
          {status?.unlocked && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
              <div className="flex shrink-0 flex-col gap-1 overflow-y-auto pr-1 sm:w-48">
                {providers.map(provider => (
                  <button
                    key={provider.id}
                    className={`truncate rounded-chip px-2 py-1 text-left text-xs ${
                      provider.id === selectedProviderId
                        ? 'bg-canvas text-ink'
                        : 'text-muted hover:text-ink'
                    }`}
                    onClick={() => { setSelectedProviderId(provider.id); setKeyForm(null); setProviderRename(null) }}
                    title={provider.name}
                  >
                    {provider.name}
                  </button>
                ))}
                <input
                  className="mt-2 rounded-chip border border-border bg-canvas px-2 py-1 text-xs"
                  placeholder="New provider…"
                  value={newProviderName}
                  onChange={e => setNewProviderName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addProvider() }}
                />
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
                {!selectedProvider && (
                  <div className="text-xs text-muted">Create a provider to get started.</div>
                )}
                {selectedProvider && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-ink">{selectedProvider.name}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          className="text-[11px] text-muted hover:text-ink"
                          onClick={() =>
                            setProviderRename({ id: selectedProvider.id, name: selectedProvider.name })
                          }
                        >
                          Rename
                        </button>
                        <button
                          className="text-[11px] text-muted hover:text-ink"
                          onClick={() => {
                            if (window.confirm(`Delete provider "${selectedProvider.name}" and all its keys?`)) {
                              void runVaultAction(() =>
                                window.api.keyVaultDeleteProvider(selectedProvider.id),
                              )
                            }
                          }}
                        >
                          Delete
                        </button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setKeyForm({ name: '', value: '', note: '' })}
                        >
                          + New Key
                        </Button>
                      </div>
                    </div>

                    {providerRename && providerRename.id === selectedProvider.id && (
                      <div className="flex items-center gap-2">
                        <input
                          className="flex-1 rounded-chip border border-border bg-canvas px-2 py-1 text-xs"
                          value={providerRename.name}
                          placeholder="Provider name"
                          onChange={e => setProviderRename({ ...providerRename, name: e.target.value })}
                          onKeyDown={e => {
                            if (e.key !== 'Enter') return
                            const name = providerRename.name.trim()
                            if (!name) return
                            const id = providerRename.id
                            setProviderRename(null)
                            void runVaultAction(() => window.api.keyVaultRenameProvider(id, name))
                          }}
                        />
                        <Button variant="ghost" size="sm" onClick={() => setProviderRename(null)}>Cancel</Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            const name = providerRename.name.trim()
                            if (!name) return
                            const id = providerRename.id
                            setProviderRename(null)
                            void runVaultAction(() => window.api.keyVaultRenameProvider(id, name))
                          }}
                        >
                          Save
                        </Button>
                      </div>
                    )}

                    {selectedKeys.map(key => (
                      <div key={key.id} className="flex flex-col gap-1 rounded-slab border border-border bg-canvas p-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                          <span className="truncate text-ink">{key.name}</span>
                          <span className="shrink-0 text-[10px] text-muted">••••{key.hint}</span>
                          {revealed.has(key.id) && (
                            <span
                              className="max-w-[220px] truncate text-[10px] text-ink"
                              title={revealed.get(key.id)}
                            >
                              {revealed.get(key.id)}
                            </span>
                          )}
                          <span className="flex-1" />
                          <button
                            className="shrink-0 text-[11px] text-muted hover:text-ink"
                            onClick={() => void toggleReveal(key)}
                          >
                            {revealed.has(key.id) ? 'Hide' : 'Reveal'}
                          </button>
                          <button
                            className="shrink-0 text-[11px] text-muted hover:text-ink"
                            onClick={() =>
                              void runVaultAction(() => window.api.keyVaultCopyKey(key.providerId, key.id))
                            }
                          >
                            Copy
                          </button>
                          <button
                            className="shrink-0 text-[11px] text-ink"
                            onClick={() => void insertKey(key)}
                          >
                            Insert
                          </button>
                          <button
                            className="shrink-0 text-[11px] text-muted hover:text-ink"
                            onClick={() => setKeyForm({ id: key.id, name: key.name, value: '', note: key.note })}
                          >
                            Edit
                          </button>
                          <button
                            className="shrink-0 text-[11px] text-muted hover:text-ink"
                            onClick={() => {
                              if (window.confirm(`Delete key "${key.name}"?`)) {
                                void runVaultAction(() =>
                                  window.api.keyVaultDeleteKey(key.providerId, key.id),
                                )
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                        {key.note && <div className="truncate text-[10px] text-muted">{key.note}</div>}
                      </div>
                    ))}

                    {keyForm && (
                      <div className="flex flex-col gap-2 rounded-slab border border-border bg-canvas p-3">
                        <div className="text-xs text-ink">{keyForm.id ? 'Edit key' : 'New key'}</div>
                        <input
                          className="rounded-chip border border-border bg-surface px-2 py-1 text-xs"
                          placeholder="Key name (e.g. main)"
                          value={keyForm.name}
                          onChange={e => setKeyForm({ ...keyForm, name: e.target.value })}
                        />
                        <input
                          className="rounded-chip border border-border bg-surface px-2 py-1 text-xs"
                          type="password"
                          placeholder={keyForm.id ? 'Value (leave blank to keep current)' : 'Value'}
                          value={keyForm.value}
                          onChange={e => setKeyForm({ ...keyForm, value: e.target.value })}
                        />
                        <input
                          className="rounded-chip border border-border bg-surface px-2 py-1 text-xs"
                          placeholder="Note (optional)"
                          value={keyForm.note}
                          onChange={e => setKeyForm({ ...keyForm, note: e.target.value })}
                        />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setKeyForm(null)}>Cancel</Button>
                          <Button size="sm" onClick={saveKeyForm}>Save</Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="justify-start text-[10px] leading-relaxed text-muted">
          Reference keys from prompt templates with {'{{key:Provider/Key}}'} · Encrypted with the OS
          keyring · One unlock per app launch · An inserted key sits in the saved draft (or terminal
          scrollback) until sent or cleared
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
