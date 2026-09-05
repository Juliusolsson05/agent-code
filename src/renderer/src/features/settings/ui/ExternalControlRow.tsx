import { useEffect, useState } from 'react'
import { externalConnectionStatusSchema, type ExternalConnectionStatus } from '@control-sdk'
import { Button } from '@renderer/components/ui/button'

export function ExternalControlRow() {
  const [status, setStatus] = useState<ExternalConnectionStatus | null>(null)
  const [port, setPort] = useState('47653')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let live = true
    const refresh = async () => {
      if (!window.api?.controlInvoke) return
      const result = await window.api.controlInvoke({ capabilityId: 'externalControl.status', input: {} })
      if (!live) return
      if (!result.ok) { setMessage(result.error.message); return }
      const value = externalConnectionStatusSchema.parse(result.value)
      setStatus(value); setPort(String(value.port))
    }
    void refresh().catch(error => { if (live) setMessage(String(error)) })
    // Refresh on returning to this window, not on token streaming. Connection
    // state is main-owned and another window may have changed it while hidden.
    const focus = () => { void refresh().catch(error => { if (live) setMessage(String(error)) }) }
    window.addEventListener('focus', focus)
    return () => { live = false; window.removeEventListener('focus', focus) }
  }, [])
  const configure = async (enabled: boolean, rotateKey = false) => {
    setBusy(true); setMessage('')
    try {
      const result = await window.api.controlInvoke({ capabilityId: 'externalControl.configure', input: { enabled, port: Number(port), rotateKey } })
      if (!result.ok) throw new Error(result.error.message)
      const value = externalConnectionStatusSchema.parse(result.value)
      setStatus(value); setPort(String(value.port))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const copy = async (format: 'codex' | 'json') => {
    setBusy(true)
    try {
      const result = await window.api.controlInvoke({ capabilityId: 'externalControl.copyConnection', input: { format } })
      if (!result.ok) throw new Error(result.error.message)
      setMessage(format === 'codex' ? 'Copied. Paste into the external Codex app’s MCP configuration.' : 'Copied MCP connection configuration.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2 text-[12px]">
    <div className="text-muted">{status ? status.running ? 'Running · global Codex connection installed' : status.enabled ? 'Enabled · connection needs attention' : 'Disabled' : 'Loading connection…'}</div>
    <label className="flex items-center justify-between gap-2">Local port
      <input aria-label="External control port" type="number" min={1024} max={65535} value={port} disabled={busy}
        onChange={event => setPort(event.target.value)} className="w-24 rounded-control border border-border bg-canvas px-2 py-1" />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy || !status} onClick={() => void configure(!status?.enabled)}>{status?.enabled ? 'Disable' : 'Enable'}</Button>
      {(status?.enabled || status?.error) && <Button variant="outline" disabled={busy} onClick={() => void configure(status?.enabled ?? false)}>Apply port / retry</Button>}
      {status?.running && <>
        <Button variant="outline" disabled={busy} onClick={() => void copy('codex')}>Copy Codex config</Button>
        <Button variant="outline" disabled={busy} onClick={() => void copy('json')}>Copy JSON config</Button>
        <Button variant="outline" disabled={busy} onClick={() => void configure(true, true)}>Rotate connection key</Button>
      </>}
    </div>
    {status?.url && <code className="break-all text-muted">{status.url}</code>}
    <p className="text-muted">Enable to install the connection and operator skill globally for external Codex. Restart your external client after setup or key rotation, then call <code>ac_app_describe</code> for the crash course and <code>ac_app_windows</code> to choose a window. Agent Code updates its managed configuration automatically. Its own agents exclude this connection and skill.</p>
    {status?.codex && <div className="break-all text-muted">Codex config: {status.codex.configPath}<br />Operator skill: {status.codex.skillPath}</div>}
    {(message || status?.error) && <div role="status" className="break-words text-muted">{status?.error ?? message}</div>}
  </div>
}
