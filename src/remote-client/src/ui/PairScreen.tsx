import { useState } from 'react'

// Manual-entry fallback for pairing. The happy path never shows this long:
// scanning the desktop QR lands with #code=… and App auto-redeems. This
// screen exists for the fallback the RemotePanel copy promises — "open the
// URL and enter the code" — and for re-pairing after a revoke.

export function PairScreen({
  busy,
  error,
  onSubmitCode,
}: {
  busy: boolean
  error: string | null
  onSubmitCode: (code: string) => Promise<void>
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    const trimmed = code.trim().toUpperCase()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onSubmitCode(trimmed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="pair">
      <h1>Agent Code Remote</h1>
      <p>
        On your desktop, open the command palette → <strong>Remote Control</strong> →{' '}
        <strong>Show QR</strong>, then scan it — or type the 8-character code here.
      </p>
      <input
        value={code}
        onChange={e => setCode(e.target.value)}
        placeholder="CODE"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={8}
        onKeyDown={e => {
          if (e.key === 'Enter') void submit()
        }}
      />
      <button
        className="mono"
        style={{
          background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
          borderRadius: 8, padding: '10px 22px', fontSize: 15, fontWeight: 600,
          opacity: busy || submitting || code.trim().length < 8 ? 0.4 : 1,
        }}
        disabled={busy || submitting || code.trim().length < 8}
        onClick={() => void submit()}
      >
        {busy || submitting ? 'Pairing…' : 'Pair'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
