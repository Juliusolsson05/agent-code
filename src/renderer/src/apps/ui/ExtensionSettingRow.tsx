import { useEffect, useRef, useState } from 'react'

/**
 * One extension-contributed setting row.
 *
 * WHY this is a self-subscribing marker row and not a generic `toggle`/`select`
 * control: the value must NOT live in the zustand-persist Settings blob. That blob
 * needs a persist-version bump on every field change (a forgotten one black-screened
 * launch twice, #249), and an extension's fields are authored outside the app's
 * release cycle, so nobody can ever bump the version for them. So the value lives in
 * the extension's own main-owned storage (`EXTENSION_STATE_DIR/<id>/state.json`, via
 * `window.api.extensionStorage*`), and this row reads/writes it over IPC — exactly
 * the pattern DictationApiKeyRow and CliUpdateBehaviorRow use for their off-blob
 * state.
 *
 * The storage key is the setting's contribution id, and the appId is the extension
 * id, so two extensions can never collide and uninstalling one leaves the other's
 * values untouched. A missing stored value falls back to the manifest `default`.
 */
type Props = {
  extensionId: string
  settingId: string
  valueType: 'boolean' | 'number' | 'string'
  defaultValue: boolean | number | string
}

export function ExtensionSettingRow({ extensionId, settingId, valueType, defaultValue }: Props) {
  const [value, setValue] = useState<boolean | number | string>(defaultValue)
  const [error, setError] = useState<string | null>(null)
  // A late IPC read must not clobber an edit the user made while it was in flight.
  const editedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = await window.api.extensionStorageGet(extensionId, settingId)
        // Only adopt the stored value if it is still the right shape AND the user
        // has not already typed something. A hand-corrupted state.json of the wrong
        // type falls back to the default rather than rendering a broken control.
        if (cancelled || editedRef.current) return
        if (stored !== undefined && typeof stored === valueType) {
          setValue(stored as boolean | number | string)
        }
      } catch (readError) {
        if (!cancelled) setError(readError instanceof Error ? readError.message : String(readError))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [extensionId, settingId, valueType])

  const persist = (next: boolean | number | string) => {
    editedRef.current = true
    setValue(next)
    setError(null)
    // Write-through. The store rejects non-finite numbers, so a NaN can never land.
    void window.api
      .extensionStorageSet(extensionId, settingId, next)
      .catch(writeError => setError(writeError instanceof Error ? writeError.message : String(writeError)))
  }

  return (
    <div className="flex flex-col gap-1.5">
      {valueType === 'boolean' ? (
        <button
          type="button"
          onClick={() => persist(!(value as boolean))}
          className="flex w-full items-center justify-between border border-control-border bg-control-bg px-3 py-2 text-left text-[12px] text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink"
        >
          <span>{value ? 'Enabled' : 'Disabled'}</span>
          <span
            className={`flex h-3.5 w-3.5 border ${
              value
                ? 'border-control-active-bg bg-control-active-bg'
                : 'border-control-border-hover bg-transparent'
            }`}
          />
        </button>
      ) : null}

      {valueType === 'number' ? (
        <input
          type="number"
          value={String(value)}
          onChange={event => {
            const parsed = Number(event.target.value)
            // Ignore an unparseable/blank field rather than writing NaN — the store
            // would reject it anyway, and clobbering the value mid-edit is hostile.
            if (Number.isFinite(parsed)) persist(parsed)
          }}
          className="w-full border border-input-border bg-input-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-input-border-focus"
        />
      ) : null}

      {valueType === 'string' ? (
        <input
          type="text"
          value={String(value)}
          onChange={event => persist(event.target.value)}
          spellCheck={false}
          className="w-full border border-input-border bg-input-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-input-border-focus"
        />
      ) : null}

      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
  )
}
