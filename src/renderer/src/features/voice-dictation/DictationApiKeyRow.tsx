import { useCallback, useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'

import type { DictationApiKeyStatus } from '@preload/api/types'

// Voice-dictation API-key row for the Settings page.
//
// WHY this row lives outside the Zustand-backed Settings pipeline:
//
//   The key is a secret. Keeping the plaintext anywhere in the renderer's
//   in-memory settings blob makes it easy for future debug bundles,
//   heap snapshots, DevTools inspection, or session recordings to
//   inadvertently ship it. Main is the security boundary — it stores the
//   ciphertext via Electron safeStorage (see src/main/dictation/
//   apiKeyStore.ts), and this row only ever sees a mask ("••••1234") and
//   whether a key is configured. When the user pastes a fresh key we ship
//   it to main immediately and clear the local input state.
//
// WHY the row self-subscribes rather than exposing a getter to Settings:
//
//   The Settings pipeline treats every setting as `Settings[key]` with a
//   getValue/onChange contract. Squeezing an async "read status, write
//   ciphertext" round-trip through that interface would require the
//   Settings type to grow either a dummy string field (bad) or a null-
//   allowed union (worse — every other consumer has to handle it). The
//   marker-row pattern used by CliUpdateBehaviorRow avoids both.
export function DictationApiKeyRow() {
  const [status, setStatus] = useState<DictationApiKeyStatus | null>(null)
  const [pending, setPending] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<'saved' | 'cleared' | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.getDictationApiKeyStatus()
      setStatus(next)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const commit = useCallback(
    async (key: string) => {
      setBusy(true)
      setError(null)
      try {
        const result = await window.api.setDictationApiKey({ key })
        if (result.ok) {
          setStatus(result.status)
          setPending('')
          setFlash(key.trim() ? 'saved' : 'cleared')
          // Flash indicator auto-clears — this is UI state, not durable
          // truth; the actual configured state comes from the returned
          // status blob above.
          setTimeout(() => setFlash(null), 2500)
        } else {
          setError(result.message)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save the key.')
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  if (!status) {
    return (
      <div className="text-[11px] text-muted italic">Loading key status…</div>
    )
  }

  const availableCopy = status.available
    ? null
    : 'System keyring is unavailable — keys stored here cannot be encrypted at rest on this machine.'

  return (
    <div className="flex flex-col gap-2">
      {availableCopy ? (
        <div
          role="status"
          className="border border-warning bg-warning/15 px-2 py-1 text-[11px] text-warning"
        >
          {availableCopy}
        </div>
      ) : null}

      {status.configured ? (
        <div className="text-[11px] text-muted">
          Current key: <code className="font-code text-ink">••••{status.hint ?? '????'}</code>{' '}
          <span className="opacity-70">
            ({status.source === 'env'
              ? 'from DEEPGRAM_API_KEY environment override'
              : 'stored in system keyring'})
          </span>
        </div>
      ) : (
        <div className="text-[11px] text-muted">
          No key configured. Paste one below to enable dictation.
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* This field used to be styled with the `control-*` family, which is
            button chrome — `input-*` is field chrome, and the two are
            independently themeable in customAppearance. Under a custom theme
            that separated them, the key field rendered as a button. */}
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={pending}
          onChange={event => setPending(event.target.value)}
          placeholder={status.configured ? 'Replace key…' : 'Paste Deepgram API key'}
          disabled={busy || status.source === 'env'}
          className="h-7 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !pending.trim() || status.source === 'env'}
          onClick={() => void commit(pending)}
        >
          Save
        </Button>
        {status.configured && status.source !== 'env' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void commit('')}
            // Danger is carried as an override rather than variant="destructive":
            // this is a clear-the-field action sitting in a settings row, not a
            // filled destructive confirm. The outline chrome stays, the text and
            // hover border go danger.
            className="text-danger hover:border-danger hover:text-danger"
            title="Clear the stored Deepgram key"
          >
            Remove
          </Button>
        ) : null}
      </div>

      {status.source === 'env' ? (
        <div className="text-[11px] text-muted">
          A DEEPGRAM_API_KEY env override is active for this run. Clear it and restart
          Agent Code to edit the settings-stored key.
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      {flash === 'saved' ? (
        <div className="text-[11px] text-accent">Saved to system keyring.</div>
      ) : null}
      {flash === 'cleared' ? (
        <div className="text-[11px] text-muted">Stored key removed.</div>
      ) : null}
    </div>
  )
}
