import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
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
import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'
import type { KeyVaultKey, KeyVaultStatus } from '@shared/types/keyVault'
import { withVisibleControls } from '@shared/text/visibleControls'

// API Key Vault modal (#831). Revealed plaintext lives only in this
// component's ephemeral state — the VAULT never persists it — and is
// cleared on lock/close/deletion. Metadata flows through the
// window.api.keyVault* calls; every secret fetch crosses the main-side
// unlock gate (one OS prompt per app run), so "Reveal" on a locked vault
// is what triggers Touch ID / the login-password prompt.
//
// DISCLOSURE (review finding): once a key is INSERTED, it leaves the
// vault's protection by design. The vault encrypts STORAGE, not the
// prompt pipeline. The full list of places an inserted key comes to
// rest, which is longer than this comment used to admit:
//
//   1. The composer draft, autosaved to workspace.json in PLAINTEXT
//      (useAutoSave writes runtime.draftInput for every session with
//      one), until the prompt is sent or the draft is cleared.
//   2. "Clear draft" does not end that — the cleared text is retained
//      for undo (draft.ts's clearedDrafts), so it stays recoverable.
//   3. A PTY paste lands in xterm scrollback and in tmux history.
//   4. Submitting puts it in the provider transcript, plaintext,
//      exactly like a manual paste.
//   5. If proxy streaming is on, the mitm addon base64-encodes outbound
//      request bodies into the proxy events journal under
//      ~/.config/agent-code/proxy, kept until debug-storage retention prunes
//      it (main/storage/debugRetention.ts).
//
// Anything meant to stay secret should be given to the agent by a path
// that does not go through a prompt at all.

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
  // What the form held when it OPENED (steering note k6): an Edit form is
  // seeded with the key's name and note, so "non-empty" is not "changed".
  // The value field is always opened blank — for an edit, blank means "keep
  // the current secret" — so any typed value is a change in both modes.
  const [keyFormBaseline, setKeyFormBaseline] = useState<{ name: string; note: string }>({ name: '', note: '' })
  const openKeyForm = (form: NonNullable<KeyForm>) => {
    setKeyForm(form)
    setKeyFormBaseline({ name: form.name, note: form.note })
  }
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

  // A key being typed is REAL input (B7's condition on plan D3) — often a
  // secret the user just copied from a provider console. Escape, an outside
  // click and Close route through requestClose, which asks before throwing an
  // edited key form away; an untouched or absent form closes at once.
  const keyFormDirty = keyForm !== null && (
    keyForm.value !== ''
    || keyForm.name !== keyFormBaseline.name
    || keyForm.note !== keyFormBaseline.note
  )
  // THE one transition guard (steering note k6): every path that would
  // replace or drop an edited key form — closing the vault, switching
  // provider by arrow or click, opening another key's Edit, "+ New Key" —
  // asks here first and proceeds only on confirmation. The confirm is
  // destructive-toned, so it opens with focus on Cancel. (Locking the vault
  // is deliberately NOT routed here: clearing plaintext on lock is a
  // security action that must not wait on a dialog.)
  //
  // Runs `proceed` SYNCHRONOUSLY when nothing is at stake: an untouched form
  // must not add a microtask of delay (or an await) to every provider switch
  // and Edit — only a real edit waits on the confirm.
  const withKeyFormGuard = (proceed: () => void) => {
    if (!keyFormDirty) {
      proceed()
      return
    }
    void requestConfirm({
      title: 'Discard this key?',
      description: 'The name and value you typed will be lost.',
      confirmLabel: 'Discard Key',
      tone: 'danger',
    }).then(confirmed => { if (confirmed) proceed() })
  }
  const requestClose = () => withKeyFormGuard(closeKeyVault)

  // The provider list is a vertical TABLIST (plan S36, same as Usage's rail):
  // one Tab stop, ↑↓ move focus and selection together, Home/End jump, wrap.
  const providerRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectProvider = (providerId: string, focus: boolean) => {
    if (providerId === selectedProviderId) return
    // Switching provider drops the form, so it goes through the guard.
    withKeyFormGuard(() => {
      setSelectedProviderId(providerId)
      setKeyForm(null)
      setProviderRename(null)
      if (focus) providerRefs.current.get(providerId)?.focus()
    })
  }
  const selectProviderIndex = (index: number) => {
    if (providers.length === 0) return
    const provider = providers[((index % providers.length) + providers.length) % providers.length]!
    selectProvider(provider.id, true)
  }
  const onProviderKeyDown = (event: React.KeyboardEvent) => {
    const current = Math.max(0, providers.findIndex(provider => provider.id === selectedProviderId))
    const next =
      event.key === 'ArrowDown' ? current + 1
        : event.key === 'ArrowUp' ? current - 1
          : event.key === 'Home' ? 0
            : event.key === 'End' ? providers.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    selectProviderIndex(next)
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
      } else if (result.reason === 'refused') {
        // The terminal's own words: which rule the text broke, not a generic
        // failure. A key with a stray control byte is worth naming exactly.
        setError(result.message)
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
    <Dialog open onOpenChange={nextOpen => { if (!nextOpen) requestClose() }}>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col overflow-hidden">
        {/* `flex` has to accompany `flex-row` here. DialogHeader's base class
            list is a plain block, so flex-row/items-center/justify-between
            were all inert and "Lock now" stacked underneath the description
            instead of sitting opposite the title. */}
        <DialogHeader className="flex flex-row items-center justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle>API Key Vault</DialogTitle>
            <DialogDescription className="mt-0.5">
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
              {/* `sm:shrink-0`, NOT `shrink-0`, and `min-h-0` on both axes'
                  worth of layout: below the sm breakpoint this row stacks as a
                  COLUMN, and a non-shrinking child there takes its full content
                  height. With the outer scroller removed, a long provider list
                  then grew past the dialog and the new overflow-hidden clipped
                  the bottom of it — including "New provider…" — with no
                  scrollbar able to reach it, because the column's own
                  overflow-y-auto cannot help an element that was never
                  constrained. Shrinking only in the row direction keeps the
                  fixed 12rem sidebar the wide layout wants. */}
              <div className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-1 sm:w-48 sm:shrink-0">
                <div role="tablist" aria-orientation="vertical" aria-label="Providers" className="flex flex-col gap-1" onKeyDown={onProviderKeyDown}>
                {providers.map(provider => (
                  <button
                    key={provider.id}
                    ref={element => {
                      if (element) providerRefs.current.set(provider.id, element)
                      else providerRefs.current.delete(provider.id)
                    }}
                    type="button"
                    role="tab"
                    aria-selected={provider.id === selectedProviderId}
                    tabIndex={provider.id === selectedProviderId || (selectedProviderId === null && provider === providers[0]) ? 0 : -1}
                    // rounded-control + the row tokens (plan T1/T7): these were
                    // pill-shaped at Round corners and used the canvas colour
                    // as their selection.
                    className={`truncate rounded-control px-2 py-1 text-left text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
                      provider.id === selectedProviderId
                        ? 'bg-row-selected-bg text-ink'
                        : 'text-muted hover:bg-row-hover-bg hover:text-ink'
                    }`}
                    onClick={() => selectProvider(provider.id, false)}
                    title={provider.name}
                  >
                    {/* The row the Delete below acts on: escaped here too, so
                        the list and the confirmation agree (#1049
                        re-review). */}
                    {withVisibleControls(provider.name)}
                  </button>
                ))}
                </div>
                <Input
                  className="mt-2 h-7 text-[12px]"
                  placeholder="New provider…"
                  value={newProviderName}
                  onChange={e => setNewProviderName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addProvider() }}
                />
              </div>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
                {!selectedProvider && (
                  <div className="text-xs text-muted">Create a provider to get started.</div>
                )}
                {selectedProvider && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{selectedProvider.name}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button type="button" variant="ghost" size="xs"
                          onClick={() =>
                            setProviderRename({ id: selectedProvider.id, name: selectedProvider.name })
                          }
                        >
                          Rename
                        </Button>
                        <Button type="button" variant="ghost" size="xs"
                          onClick={() => {
                            // Names are user-typed and the validator permits
                            // invisible characters, so `production` and
                            // `production<U+200B>` coexist and read the same
                            // — in the list and in this confirmation, which
                            // is where a whole provider's keys are destroyed
                            // (#1049 re-review).
                            void requestConfirm({
                              title: `Delete provider "${withVisibleControls(selectedProvider.name)}" and all its keys?`,
                              confirmLabel: 'Delete Provider',
                              tone: 'danger',
                            }).then(confirmed => {
                              if (!confirmed) return
                              void runVaultAction(() =>
                                window.api.keyVaultDeleteProvider(selectedProvider.id),
                              )
                            })
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => withKeyFormGuard(() => openKeyForm({ name: '', value: '', note: '' }))}
                        >
                          + New Key
                        </Button>
                      </div>
                    </div>

                    {providerRename && providerRename.id === selectedProvider.id && (
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-7 flex-1 text-[12px]"
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
                          <span className="truncate text-ink">{withVisibleControls(key.name)}</span>
                          <span className="shrink-0 text-[10px] text-muted">••••{key.hint}</span>
                          {revealed.has(key.id) && (
                            // WHY no `title` attribute here, and why it wraps
                            // instead of truncating: a `title` puts the
                            // plaintext secret into an OS tooltip and into the
                            // accessibility tree, where it is readable by
                            // anything that can query the DOM and is rendered
                            // by the window server outside this surface's
                            // control. Truncating created the need for that
                            // tooltip, so the fix is to let the value wrap and
                            // be fully visible in the row instead.
                            <span className="min-w-0 text-[10px] text-ink [overflow-wrap:anywhere]">
                              {revealed.get(key.id)}
                            </span>
                          )}
                          <span className="flex-1" />
                          <Button type="button" variant="ghost" size="xs"
                            onClick={() => void toggleReveal(key)}
                          >
                            {revealed.has(key.id) ? 'Hide' : 'Reveal'}
                          </Button>
                          <Button type="button" variant="ghost" size="xs"
                            onClick={() =>
                              void runVaultAction(() => window.api.keyVaultCopyKey(key.providerId, key.id))
                            }
                          >
                            Copy
                          </Button>
                          <Button type="button" variant="outline" size="xs"
                            onClick={() => void insertKey(key)}
                          >
                            Insert
                          </Button>
                          <Button type="button" variant="ghost" size="xs"
                            onClick={() => withKeyFormGuard(() => openKeyForm({ id: key.id, name: key.name, value: '', note: key.note }))}
                          >
                            Edit
                          </Button>
                          <Button type="button" variant="ghost" size="xs"
                            onClick={() => {
                              void requestConfirm({
                                title: `Delete key "${withVisibleControls(key.name)}"?`,
                                confirmLabel: 'Delete Key',
                                tone: 'danger',
                              }).then(confirmed => {
                                if (!confirmed) return
                                void runVaultAction(() =>
                                  window.api.keyVaultDeleteKey(key.providerId, key.id),
                                )
                              })
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                        {key.note && <div className="truncate text-[10px] text-muted">{key.note}</div>}
                      </div>
                    ))}

                    {keyForm && (
                      // Enter in any field saves the key (plan S36) — the
                      // form had no key at all — and Save carries ↩ to say so.
                      <div
                        className="flex flex-col gap-2 rounded-slab border border-border bg-canvas p-3"
                        onKeyDown={event => {
                          if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
                          if (!(event.target instanceof HTMLInputElement)) return
                          event.preventDefault()
                          saveKeyForm()
                        }}
                      >
                        <div className="text-xs text-ink">{keyForm.id ? 'Edit key' : 'New key'}</div>
                        <Input
                          className="h-7 text-[12px]"
                          placeholder="Key name (e.g. main)"
                          value={keyForm.name}
                          onChange={e => setKeyForm({ ...keyForm, name: e.target.value })}
                        />
                        <Input
                          className="h-7 text-[12px]"
                          type="password"
                          placeholder={keyForm.id ? 'Value (leave blank to keep current)' : 'Value'}
                          value={keyForm.value}
                          onChange={e => setKeyForm({ ...keyForm, value: e.target.value })}
                        />
                        <Input
                          className="h-7 text-[12px]"
                          placeholder="Note (optional)"
                          value={keyForm.note}
                          onChange={e => setKeyForm({ ...keyForm, note: e.target.value })}
                        />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setKeyForm(null)}>Cancel</Button>
                          <Button size="sm" onClick={saveKeyForm}>Save<Kbd binding="Enter" tone="onAccent" /></Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* The explanatory note stays as body text above the footer (it
            occupied the whole footer with no way out but Escape); the footer
            is now the close-only `Close ⎋` (plan H5). */}
        <p className="border-t border-border px-4 py-2 text-[10px] leading-relaxed text-muted">
          Reference keys from prompt templates with {'{{key:Provider/Key}}'} · Encrypted with the OS
          keyring · One unlock per app launch · An inserted key sits in the saved draft (or terminal
          scrollback) until sent or cleared
        </p>
        <DialogActions onCancel={requestClose} cancelLabel="Close" />
      </DialogContent>
    </Dialog>
  )
}
