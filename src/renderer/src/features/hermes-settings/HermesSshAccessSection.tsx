// The "SSH access" block of a Hermes connection card (#1528).
//
// Optional and separate from the URL sign-in: the URL is how Agent Code
// TALKS to Hermes, SSH is how the user gets a shell on the same server
// (Open VPS Terminal / Open Hermes Terminal). Nothing here holds a secret:
// a destination, a port and a key PATH. Authentication is the user's own
// ssh-agent and ~/.ssh/config, exactly as in their own terminal.
//
// Generic on purpose: Hermes runs on any VPS. The placeholders name the
// shapes (user@host, a config alias), never a vendor, and "where Hermes
// runs" is detected over SSH, or typed, never assumed from an image name.

import { useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import type { HermesDetection, HermesLocation } from '@shared/hermes/ssh'
import type { HermesConnectionInfo } from '@shared/hermes/types'

function errorText(error: unknown): string {
  // Electron prefixes IPC rejections with "Error invoking remote method …:".
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function locationText(location: HermesLocation | undefined): string {
  if (!location) return 'where Hermes runs is not known yet'
  if (location.kind === 'host') return 'Hermes runs on the server itself'
  return `Hermes runs in container ${location.container}${location.sudo ? ' (Docker through sudo)' : ''}`
}

export function HermesSshAccessSection({ connection }: { connection: HermesConnectionInfo }) {
  const ssh = connection.ssh
  const [editing, setEditing] = useState(false)
  const [destination, setDestination] = useState(ssh?.destination ?? '')
  const [port, setPort] = useState(ssh?.port !== undefined ? String(ssh.port) : '')
  const [identityFile, setIdentityFile] = useState(ssh?.identityFile ?? '')
  const [container, setContainer] = useState(ssh?.hermes?.kind === 'docker' ? ssh.hermes.container : '')
  const [sudo, setSudo] = useState(ssh?.hermes?.kind === 'docker' ? ssh.hermes.sudo : false)
  const [onHost, setOnHost] = useState(ssh?.hermes?.kind === 'host')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [detection, setDetection] = useState<HermesDetection | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try {
      await action()
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const resetFields = () => {
    setDestination(ssh?.destination ?? '')
    setPort(ssh?.port !== undefined ? String(ssh.port) : '')
    setIdentityFile(ssh?.identityFile ?? '')
    setContainer(ssh?.hermes?.kind === 'docker' ? ssh.hermes.container : '')
    setSudo(ssh?.hermes?.kind === 'docker' ? ssh.hermes.sudo : false)
    setOnHost(ssh?.hermes?.kind === 'host')
  }

  if (editing) {
    return (
      <form
        className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2"
        aria-label="SSH access"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await window.api.hermesSetSsh(connection.id, { destination, port, identityFile, container, sudo, onHost })
            setEditing(false)
            setDetection(null)
          })
        }}
      >
        <Input aria-label="SSH destination" placeholder="user@203.0.113.7, or a Host alias from ~/.ssh/config" value={destination} onChange={(event) => setDestination(event.target.value)} />
        <div className="flex gap-1.5">
          <Input className="w-24" aria-label="SSH port" placeholder="Port (22)" value={port} onChange={(event) => setPort(event.target.value)} />
          <Input className="min-w-0 flex-1" aria-label="SSH identity file" placeholder="Key file, e.g. ~/.ssh/id_ed25519 (optional)" value={identityFile} onChange={(event) => setIdentityFile(event.target.value)} />
        </div>
        {/* Where Hermes runs is an explicit choice (review of #1530): an
            empty container field cannot also mean "the server itself", or
            a user Detect could not decide for has no way to pick the host. */}
        <label className="flex items-center gap-1 text-[11px] text-muted">
          <input type="checkbox" aria-label="Hermes runs on the server itself" checked={onHost} onChange={(event) => setOnHost(event.target.checked)} />
          Hermes runs on the server itself (not in a container)
        </label>
        <div className="flex items-center gap-1.5">
          <Input className="min-w-0 flex-1" aria-label="Hermes container" placeholder="Hermes container (empty: use Detect)" disabled={onHost} value={onHost ? '' : container} onChange={(event) => setContainer(event.target.value)} />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" disabled={onHost} checked={sudo && !onHost} onChange={(event) => setSudo(event.target.checked)} />
            Docker needs sudo
          </label>
        </div>
        <p className="text-[11px] text-muted">Agent Code signs in with your SSH key and ~/.ssh/config, never a password, and never changes your SSH files.</p>
        {problem && <p className="text-danger" role="alert">{problem}</p>}
        <div className="flex gap-1.5">
          <Button type="submit" size="sm" disabled={busy || !destination.trim()}>Save SSH access</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setProblem(null); resetFields() }}>Cancel</Button>
        </div>
      </form>
    )
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      {ssh ? (
        <p className="text-ink-dim">
          SSH <span className="font-code text-[11px]">{ssh.destination}{ssh.port !== undefined ? `:${ssh.port}` : ''}</span> · {locationText(ssh.hermes)}
        </p>
      ) : (
        <p className="text-muted">No SSH access. Add it to open a terminal on this server (Open VPS Terminal, Open Hermes Terminal).</p>
      )}
      {detection && <p className={`mt-1 text-[11px] ${detection.ok ? 'text-ink-dim' : 'text-danger'}`}>{detection.message}</p>}
      {problem && <p className="mt-1 text-danger">{problem}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {/* Disabled while Detect runs: a form opened now would snapshot the
            fields BEFORE the detected location lands, and saving it later
            erased that result (review of #1530). */}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { resetFields(); setEditing(true) }}>{ssh ? 'Edit SSH access' : 'Add SSH access'}</Button>
        {ssh && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setDetection(await window.api.hermesDetect(connection.id)))}>
              {busy ? 'Detecting…' : 'Detect where Hermes runs'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await window.api.hermesSetSsh(connection.id, null); setDetection(null) })}>Remove SSH access</Button>
          </>
        )}
      </div>
    </div>
  )
}
