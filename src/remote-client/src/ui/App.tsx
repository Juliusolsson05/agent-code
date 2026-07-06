import { useEffect, useMemo, useState } from 'react'

import {
  WebSocketSessionFeed,
  type ConnectionState,
} from '../WebSocketSessionFeed'
import { TranscriptStore } from '../transcript/store'
import {
  clearToken,
  defaultDeviceName,
  loadToken,
  readPairingCodeFromHash,
  redeemPairingCode,
  scrubPairingCodeFromHash,
} from '../pairing'
import { PairScreen } from './PairScreen'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'

// Phone app shell. Three states, one screen each:
//   no token            → PairScreen (QR hash auto-redeem or manual code)
//   token, no selection → SessionList
//   token + selection   → SessionView
//
// The feed is created once per token and torn down when the token dies —
// its identity is what everything below subscribes to, so it must be as
// stable as the desktop's module-const ipcSessionFeed (see the dep-array
// WHY on useIpcSubscriptions).

function wsUrlForPage(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws`
}

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => loadToken())
  const [pairError, setPairError] = useState<string | null>(null)
  const [autoPairing, setAutoPairing] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')

  // QR flow: the desktop QR is `${url}/#code=…`; if we land with a code and
  // no token yet, redeem it immediately — the user's only gesture is the scan.
  useEffect(() => {
    if (token) return
    const code = readPairingCodeFromHash()
    if (!code) return
    setAutoPairing(true)
    void redeemPairingCode(code, defaultDeviceName()).then(result => {
      setAutoPairing(false)
      scrubPairingCodeFromHash()
      if (result.ok) {
        setPairError(null)
        setToken(result.token)
      } else {
        setPairError(result.error)
      }
    })
  }, [token])

  const feed = useMemo(
    () => (token ? new WebSocketSessionFeed({ url: wsUrlForPage(), token }) : null),
    [token],
  )
  // One transcript store per feed lifetime: it owns the per-session
  // ingest state (seen-uuid sets, stateful codex mapper cursors) that must
  // survive navigation between the list and session screens.
  const store = useMemo(() => (feed ? new TranscriptStore(feed) : null), [feed])

  useEffect(() => {
    if (!feed) return
    const off = feed.onConnectionState(setConnection)
    return () => {
      off()
      store?.dispose()
      feed.dispose()
    }
  }, [feed, store])

  const unpair = (): void => {
    // Local unpair only — the durable revocation lives on the desktop's
    // device list. Clearing the token here just makes THIS phone forget.
    clearToken()
    setSelectedSessionId(null)
    setToken(null)
  }

  if (!token || !feed) {
    return (
      <PairScreen
        busy={autoPairing}
        error={pairError}
        onSubmitCode={async code => {
          const result = await redeemPairingCode(code, defaultDeviceName())
          if (result.ok) {
            setPairError(null)
            setToken(result.token)
          } else {
            setPairError(result.error)
          }
        }}
      />
    )
  }

  if (!selectedSessionId) {
    return (
      <SessionList
        feed={feed}
        connection={connection}
        onSelect={setSelectedSessionId}
        onUnpair={unpair}
      />
    )
  }

  if (!store) return <PairScreen busy={false} error={null} onSubmitCode={async () => {}} />

  return (
    <SessionView
      feed={feed}
      store={store}
      connection={connection}
      sessionId={selectedSessionId}
      onBack={() => setSelectedSessionId(null)}
    />
  )
}
