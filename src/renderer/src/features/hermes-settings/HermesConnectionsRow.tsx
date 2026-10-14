// Settings → Providers → Hermes connections (#1482).
//
// A marker row like ProviderEnablementRow: the value lives in MAIN
// (connections.json + safeStorage tokens), so the row owns its subscription.
// Every state has its own sentence and a way forward (signed out → Sign in,
// unreachable → Test, skew → which version was tested), because a remote
// connection fails in ways a local CLI never does.
//
// Nothing here ever holds a credential: signing in opens the system browser
// on the Hermes server's own sign-in page; main receives and keeps the tokens.

import { useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useHermesConnections } from '@renderer/features/hermes-chat/useHermesConnections'
import type { HermesConnectionInfo, HermesTestResult } from '@shared/hermes/types'

function errorText(error: unknown): string {
  // Electron prefixes IPC rejections with "Error invoking remote method …:".
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function stateLine(connection: HermesConnectionInfo): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (connection.state) {
    case 'ready': {
      const who = connection.identity ? `Signed in as ${connection.identity.userId} (${connection.identity.provider})` : 'Signed in'
      if (connection.backend?.compatibility === 'unsupported') {
        return { text: `${who} · this Hermes is too old for Agent Code (needs a release with server requests, v0.21.7 tested). Run \`hermes update\` on the server.`, tone: 'warn' }
      }
      if (connection.backend?.compatibility === 'skew') {
        return { text: `${who} · Hermes contract ${connection.backend.desktopContract} (Agent Code was tested with 8): it should work; update one side if anything looks off.`, tone: 'warn' }
      }
      return { text: who, tone: 'ok' }
    }
    case 'signing-in':
      return { text: 'Waiting for you to sign in in your browser…', tone: 'muted' }
    case 'unreachable':
      return { text: connection.lastError ?? 'Hermes did not answer.', tone: 'warn' }
    case 'signed-out':
      return { text: connection.lastError ?? 'Not signed in.', tone: 'muted' }
  }
}

function ConnectionCard({ connection }: { connection: HermesConnectionInfo }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [test, setTest] = useState<HermesTestResult | null>(null)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(connection.name)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const line = stateLine(connection)

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

  return (
    <div className="rounded-slab border border-border bg-surface px-3 py-2.5 text-[12px]" data-hermes-connection={connection.id}>
      {editing ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await window.api.hermesUpdate(connection.id, { name, baseUrl })
              setEditing(false)
            })
          }}
        >
          <Input aria-label="Connection name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input aria-label="Hermes URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          <p className="text-[11px] text-muted">Changing the URL signs this connection out: tokens only ever go to the server that issued them.</p>
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={busy}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-ink">☤ {connection.name}</span>
            <span className="min-w-0 truncate font-code text-[11px] text-muted">{connection.baseUrl}</span>
          </div>
          <p className={`mt-1 ${line.tone === 'warn' ? 'text-danger' : line.tone === 'ok' ? 'text-ink-dim' : 'text-muted'}`}>{line.text}</p>
          {test && (
            <p className="mt-1 text-[11px] text-muted">
              {test.ok
                ? `Reached Hermes ${test.version}${test.authRequired ? ` · sign-in: ${test.providers.join(', ') || 'required'}` : ' · no sign-in required'}`
                : test.error}
            </p>
          )}
          {problem && <p className="mt-1 text-danger">{problem}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {connection.state === 'signing-in' ? (
              <Button size="sm" variant="outline" onClick={() => void window.api.hermesCancelSignIn(connection.id)}>Cancel sign-in</Button>
            ) : connection.state === 'signed-out' ? (
              <Button size="sm" disabled={busy} onClick={() => void run(() => window.api.hermesSignIn(connection.id))}>Sign in</Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.api.hermesSignOut(connection.id))}>Sign out</Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setTest(await window.api.hermesTest(connection.id)))}>Test</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.api.hermesRemove(connection.id))}>Remove</Button>
          </div>
        </>
      )}
    </div>
  )
}

export function HermesConnectionsRow() {
  const connections = useHermesConnections()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex w-full flex-col gap-2">
      {connections === null ? (
        <p className="text-[12px] text-muted">Loading Hermes connections…</p>
      ) : connections.length === 0 ? (
        <p className="text-[12px] text-muted">
          No Hermes connection yet. Run <span className="font-code">hermes serve</span> on your server (with a password or Nous sign-in), then add its URL here.
        </p>
      ) : (
        connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} />)
      )}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setProblem(null)
          void window.api.hermesAdd({ name, baseUrl })
            .then(async (added) => {
              setName('')
              setBaseUrl('')
              // Straight into sign-in: an added connection is useless until then.
              await window.api.hermesSignIn(added.id).catch((error: unknown) => setProblem(errorText(error)))
            })
            .catch((error: unknown) => setProblem(errorText(error)))
            .finally(() => setBusy(false))
        }}
      >
        <Input className="w-40" aria-label="New connection name" placeholder="Name (e.g. Homelab)" value={name} onChange={(event) => setName(event.target.value)} />
        <Input className="min-w-0 flex-1" aria-label="New Hermes URL" placeholder="https://hermes.example.com or 100.64.0.1:9119" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        <Button type="submit" size="sm" disabled={busy || !name.trim() || !baseUrl.trim()}>Add and sign in</Button>
      </form>
      {problem && <p className="text-[12px] text-danger">{problem}</p>}
    </div>
  )
}
