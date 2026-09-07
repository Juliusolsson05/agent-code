import { useCallback, useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useAppStore } from '@renderer/app-state/hooks'
import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import type { KeyVaultKey, KeyVaultStatus } from '@shared/types/keyVault'

// API Key Vault modal (#831). Revealed plaintext lives ONLY in this
// component's state — never in the persisted app store, never in a
// journal — and is dropped on close. Metadata flows through the
// window.api.keyVault* calls; every secret fetch crosses the main-side
// unlock gate (one OS prompt per app run), so "Reveal" on a locked vault
// is what triggers Touch ID / the login-password prompt.

type KeyForm = { id?: string; name: string; value: string; note: string } | null

export function KeyVaultModal() {
  const closeKeyVault = useAppStore(state => state.closeKeyVault)
  const workspace = useWorkspace()
  const [status, setStatus] = useState<KeyVaultStatus | null>(null)
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [keys, setKeys] = useState<KeyVaultKey[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  // keyId -> revealed plaintext. Ephemeral by design; never persisted.
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map())
  const [newProviderName, setNewProviderName] = useState('')
  const [keyForm, setKeyForm] = useState<KeyForm>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, snapshot] = await Promise.all([
        window.api.keyVaultStatus(),
        window.api.keyVaultList(),
      ])
      setStatus(nextStatus)
      setProviders(snapshot.providers)
      setKeys(snapshot.keys)
      setSelectedProviderId(current => {
        if (current && snapshot.providers.some(p => p.id === current)) return current
        return snapshot.providers[0]?.id ?? null
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // Drop all plaintext the moment the modal unmounts.
    return () => setRevealed(new Map())
  }, [])

  const runVaultAction = async (action: () => Promise<void>) => {
    try {
      await action()
      await refresh()
      setError(null)
    } catch (err) {
      // Canceled OS prompt, fail-closed gate, duplicate name, … — the
      // service messages are written for direct display.
      setError(err instanceof Error ? err.message : String(err))
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
    setKeyForm(null)
    void runVaultAction(() => window.api.keyVaultPutKey({
      providerId: selectedProviderId,
      id: form.id,
      name: form.name,
      value: form.value,
      note: form.note,
    }))
  }

  const toggleReveal = async (key: KeyVaultKey) => {
    if (revealed.has(key.id)) {
      const next = new Map(revealed)
      next.delete(key.id)
      setRevealed(next)
      return
    }
    try {
      const value = await window.api.keyVaultReveal(key.providerId, key.id)
      setRevealed(prev => new Map(prev).set(key.id, value))
      setStatus(prev => (prev ? { ...prev, unlocked: true } : prev))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const insertKey = async (key: KeyVaultKey) => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) {
      setError('No focused pane to insert into')
      return
    }
    try {
      const value = revealed.get(key.id) ?? await window.api.keyVaultReveal(key.providerId, key.id)
      const result = await deliverTextToSession(workspace, sessionId, value)
      if (result.delivered) {
        workspace.showPaneToast(sessionId, `Inserted key: ${key.name}`)
        closeKeyVault()
      } else {
        setError('Focused pane is no longer available')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const selectedKeys = keys.filter(k => k.providerId === selectedProviderId)
  const selectedProvider = providers.find(p => p.id === selectedProviderId) ?? null

  return (
    <Dialog open onOpenChange={nextOpen => { if (!nextOpen) closeKeyVault() }}>
      <DialogContent className="flex max-h-[85vh] w-[min(760px,calc(100vw-2rem))] flex-col">
        <DialogHeader className="flex-row items-center justify-between gap-4">
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
              onClick={() => void runVaultAction(() => window.api.keyVaultLock())}
            >
              Lock now
            </Button>
          )}
        </DialogHeader>

        {status && !status.encryptionAvailable && (
          <div className="text-[11px] text-ink bg-surface border border-border rounded px-2 py-1">
            OS keyring (safeStorage) is unavailable on this machine — keys cannot be stored.
          </div>
        )}
        {error && (
          <div className="text-[11px] text-ink bg-surface border border-border rounded px-2 py-1">{error}</div>
        )}

        <div className="flex flex-1 min-h-0 gap-3">
          <div className="w-48 flex flex-col gap-1 overflow-y-auto pr-1">
            {providers.map(provider => (
              <button
                key={provider.id}
                className={`text-left px-2 py-1 rounded-chip truncate text-xs ${
                  provider.id === selectedProviderId
                    ? 'bg-surface text-ink'
                    : 'text-muted hover:text-ink'
                }`}
                onClick={() => setSelectedProviderId(provider.id)}
                title={provider.name}
              >
                {provider.name}
              </button>
            ))}
            <input
              className="bg-surface border border-border rounded-chip px-2 py-1 text-xs mt-2"
              placeholder="New provider…"
              value={newProviderName}
              onChange={e => setNewProviderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addProvider() }}
            />
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-2">
            {!selectedProvider && (
              <div className="text-muted text-xs">Create a provider to get started.</div>
            )}
            {selectedProvider && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink font-semibold text-sm">{selectedProvider.name}</span>
                  <div className="flex items-center gap-2">
                    <button
                      className="text-[11px] text-muted hover:text-ink"
                      onClick={() => {
                        const name = window.prompt('Rename provider', selectedProvider.name)
                        if (name && name.trim()) {
                          void runVaultAction(() =>
                            window.api.keyVaultRenameProvider(selectedProvider.id, name),
                          )
                        }
                      }}
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

                {selectedKeys.map(key => (
                  <div key={key.id} className="border border-border rounded-chip p-2 flex flex-col gap-1 bg-surface">
                    <div className="flex items-center gap-2 min-w-0 text-xs">
                      <span className="text-ink truncate">{key.name}</span>
                      <span className="text-[10px] text-muted shrink-0">••••{key.hint}</span>
                      {revealed.has(key.id) && (
                        <span
                          className="text-[10px] text-ink truncate max-w-[220px]"
                          title={revealed.get(key.id)}
                        >
                          {revealed.get(key.id)}
                        </span>
                      )}
                      <span className="flex-1" />
                      <button
                        className="text-[11px] text-muted hover:text-ink shrink-0"
                        onClick={() => void toggleReveal(key)}
                      >
                        {revealed.has(key.id) ? 'Hide' : 'Reveal'}
                      </button>
                      <button
                        className="text-[11px] text-muted hover:text-ink shrink-0"
                        onClick={() =>
                          void runVaultAction(() => window.api.keyVaultCopyKey(key.providerId, key.id))
                        }
                      >
                        Copy
                      </button>
                      <button
                        className="text-[11px] text-ink shrink-0"
                        onClick={() => void insertKey(key)}
                      >
                        Insert
                      </button>
                      <button
                        className="text-[11px] text-muted hover:text-ink shrink-0"
                        onClick={() => setKeyForm({ id: key.id, name: key.name, value: '', note: key.note })}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[11px] text-muted hover:text-ink shrink-0"
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
                    {key.note && <div className="text-[10px] text-muted truncate">{key.note}</div>}
                  </div>
                ))}

                {keyForm && (
                  <div className="border border-border rounded-chip p-3 flex flex-col gap-2 bg-surface">
                    <div className="text-xs text-ink">{keyForm.id ? 'Edit key' : 'New key'}</div>
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1 text-xs"
                      placeholder="Key name (e.g. main)"
                      value={keyForm.name}
                      onChange={e => setKeyForm({ ...keyForm, name: e.target.value })}
                    />
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1 text-xs"
                      type="password"
                      placeholder={keyForm.id ? 'Value (leave blank to keep current)' : 'Value'}
                      value={keyForm.value}
                      onChange={e => setKeyForm({ ...keyForm, value: e.target.value })}
                    />
                    <input
                      className="bg-canvas border border-border rounded-chip px-2 py-1 text-xs"
                      placeholder="Note (optional)"
                      value={keyForm.note}
                      onChange={e => setKeyForm({ ...keyForm, note: e.target.value })}
                    />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setKeyForm(null)}>Cancel</Button>
                      <Button size="sm" onClick={saveKeyForm}>Save</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="text-[10px] text-muted border-t border-border pt-2">
          Reference keys from prompt templates with {'{{key:Provider/Key}}'} · Encrypted with the OS
          keyring · One unlock per app launch
        </div>
      </DialogContent>
    </Dialog>
  )
}
