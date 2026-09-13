import { useEffect, useMemo, useState } from 'react'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { tldrActivity, tldrTime } from './freshness'

function Timestamp({ label, timestamp, now }: { label: string; timestamp: number | null; now: number }) {
  const value = tldrTime(timestamp, now)
  return <span>{label} <time dateTime={value.iso} title={value.exact}
    aria-label={`${label} ${value.text}${value.exact ? ` (${value.exact})` : ''}`}>{value.text}</time></span>
}

export function TldrFreshness({ runtime, writtenAt, writtenLabel = 'Note written', enforcementInactive = false }: { runtime?: SessionRuntime; writtenAt?: string; writtenLabel?: string; enforcementInactive?: boolean }) {
  const [now, setNow] = useState(Date.now)
  const activity = useMemo(() => tldrActivity(runtime), [runtime])
  useEffect(() => {
    // This component exists only while peeking. Closing the preview removes
    // its clock entirely; hundreds of hidden agents incur no timer work.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return <div data-tldr-freshness="" className="absolute inset-x-4 bottom-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] leading-4 text-muted">
    {activity.active ? <span>Last active <span>now</span></span> : <Timestamp label="Last active" timestamp={activity.timestamp} now={now} />}
    <Timestamp label={writtenLabel} timestamp={writtenAt ? Date.parse(writtenAt) : null} now={now} />
    {enforcementInactive && <span data-tldr-enforcement-inactive="">Reporting check inactive</span>}
  </div>
}
