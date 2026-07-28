import { useCallback, useEffect, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useExtensionHost } from '@renderer/apps/host/ExtensionHostProvider'

import type { ExtensionListEntry } from '@shared/types/extensions'

/**
 * Settings → Extensions. Install from a GitHub repository, list what is installed,
 * remove.
 *
 * WHY this row owns its own state and IPC rather than reading a store: same
 * self-subscribing marker pattern as CliUpdateBehaviorRow and DictationApiKeyRow —
 * the truth lives in main (`extensions.json` plus the bundle directories), not in
 * the renderer's Settings, and mirroring it into zustand-persist would put
 * third-party-derived data into the blob whose version bumps have black-screened
 * launch twice (#249).
 *
 * WHY installing is deliberately a paste-a-repo box and not a browsable directory:
 * there is no registry to browse, and inventing one would mean hosting an index
 * before a single extension exists. The repo name IS the trust decision — the user
 * typing `owner/repo` is the consent step, which is why there is no second
 * confirmation dialog for a first install.
 */
export function AppsSettingsRow() {
  const [entries, setEntries] = useState<ExtensionListEntry[] | null>(null)
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Push the refreshed list into the store as well as local state: the palette
  // and the view host read from the store, so an install that only updated this
  // component would add an extension nobody else could see until a reload.
  const setInstalledExtensions = useAppStore(state => state.setInstalledExtensions)
  const failures = useAppStore(state => state.extensionFailures)
  // Needed to tear a live extension down on remove/update. Main has no handle on
  // the renderer-side host, so deactivation can only be driven from here — without
  // it a removed extension's intervals/listeners/registrations leak for the session.
  const extensionHost = useExtensionHost()

  const refresh = useCallback(async () => {
    try {
      const listed = await window.api.extensionsList()
      setEntries(listed)
      setInstalledExtensions(listed)
    } catch (listError) {
      // A failed list is not the same as an empty list, and rendering "no
      // extensions" over an IPC failure would be a lie the user acts on.
      setEntries([])
      setError(listError instanceof Error ? listError.message : String(listError))
    }
  }, [setInstalledExtensions])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // `target` is explicit rather than always read from `repo` so the Update button
  // can install a specific entry's repo. The previous version did
  // `setRepo(entry.repo); void install()`, but `setRepo` is async and `install`
  // closed over the OLD `repo`, so Update installed the empty/last-typed value —
  // the no-op bug. Passing the target directly removes the closure dependency.
  const install = useCallback(
    async (target?: string) => {
      const repoTarget = (target ?? repo).trim()
      if (!repoTarget || busy) return

      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const result = await window.api.extensionsInstall(repoTarget)
        if (result.ok) {
          if (target === undefined) setRepo('')
          setNotice(`Installed ${result.entry.manifest.name} ${result.entry.manifest.version}`)
        } else {
          setError(result.error)
        }
      } catch (installError) {
        // installExtension returns {ok:false} for every anticipated failure, so
        // reaching here means the IPC itself broke — worth showing distinctly rather
        // than swallowing.
        setError(installError instanceof Error ? installError.message : String(installError))
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [repo, busy, refresh],
  )

  // Update = reinstall over the existing bundle (install.ts does rm+rename). The
  // OLD module is still loaded in the renderer's ESM realm with live subscriptions;
  // deactivate it first so its disposers run before the bundle is replaced. The new
  // bundle re-activates lazily (or on next startup) under the version+sha cache key.
  const update = useCallback(
    async (entry: ExtensionListEntry) => {
      await extensionHost?.deactivate(entry.manifest.id)
      await install(entry.repo)
    },
    [extensionHost, install],
  )

  const remove = useCallback(
    async (entry: ExtensionListEntry) => {
      setError(null)
      setNotice(null)
      try {
        // Tear the live extension down BEFORE deleting its files: deactivate()
        // disposes the loaded module's subscriptions and registrations (it works
        // off the in-memory module, not the bundle on disk). Skipping this leaked
        // intervals/listeners for the rest of the session.
        await extensionHost?.deactivate(entry.manifest.id)
        await window.api.extensionsRemove(entry.manifest.id)
        setNotice(`Removed ${entry.manifest.name}`)
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message : String(removeError))
      } finally {
        await refresh()
      }
    },
    [extensionHost, refresh],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          value={repo}
          onChange={event => setRepo(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              // Stop the Enter reaching Settings' own handlers or, worse, a
              // background composer. The interaction-ownership marker on the
              // Settings takeover root covers the global routers, but the local
              // keydown still needs to not bubble into Settings itself.
              event.preventDefault()
              event.stopPropagation()
              void install()
            }
          }}
          placeholder="owner/repo or a github.com URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
          className="min-w-0 flex-1 border border-input-border bg-input-bg px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-input-placeholder focus:border-input-border-focus disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy || repo.trim().length === 0}
          className="shrink-0 border border-control-border bg-control-bg px-3 py-1.5 text-[12px] text-control-fg outline-none hover:border-control-border-hover disabled:opacity-40"
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>

      {error ? (
        <div className="border border-border bg-row-bg px-3 py-2 text-[12px] text-ink">{error}</div>
      ) : null}
      {notice ? <div className="text-[12px] text-muted">{notice}</div> : null}

      {entries === null ? (
        <div className="text-[12px] text-muted">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-[12px] text-muted">
          No extensions installed. Paste a repository above to install one.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {entries.map(entry => (
            <div
              key={entry.manifest.id}
              className="flex items-center justify-between gap-4 border border-border bg-row-bg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] text-ink">{entry.manifest.name}</span>
                  <span className="text-[11px] text-muted">{entry.manifest.version}</span>
                  {/* A ledger row whose bundle is gone. Shown rather than filtered:
                      the fix is reinstalling from the recorded repo, and hiding it
                      would leave the user wondering where the extension went. */}
                  {!entry.present ? (
                    <span className="text-[11px] text-ink-dim">· files missing</span>
                  ) : null}
                  {/* An extension whose module threw during import or activate.
                      Shown here rather than only in the console: a silently
                      missing extension is undiagnosable for whoever installed
                      it, and the message names the actual fault. */}
                  {failures.some(failure => failure.id === entry.manifest.id) ? (
                    <span className="text-[11px] text-ink-dim">· failed to start</span>
                  ) : null}
                </div>
                <div className="truncate text-[12px] text-muted">{entry.manifest.description}</div>
                <div className="truncate text-[11px] text-ink-dim">
                  {entry.repo} @ {entry.ref}
                </div>
                {failures.find(failure => failure.id === entry.manifest.id) ? (
                  <div className="mt-1 text-[11px] text-ink">
                    {failures.find(failure => failure.id === entry.manifest.id)?.error}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => void update(entry)}
                  disabled={busy}
                  className="border border-control-border bg-control-bg px-3 py-1 text-[12px] text-control-fg outline-none hover:border-control-border-hover disabled:opacity-40"
                >
                  Update
                </button>
                <button
                  type="button"
                  onClick={() => void remove(entry)}
                  className="border border-control-border px-3 py-1 text-[12px] text-ink-dim outline-none hover:border-control-border-hover hover:text-ink"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
