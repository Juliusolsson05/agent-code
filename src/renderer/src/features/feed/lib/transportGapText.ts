import type { TransportGapRecord } from '@shared/types/session'

/**
 * The durable "not captured" row's one sentence (#1381; wording from the
 * owner-approved decision, B6 proxy 2026-09-27: "part of this response was
 * not captured: <time span>").
 *
 * WHY a span and not "N generations lost": generations are a transport detail
 * the user cannot map to anything; the time window is where to look in the
 * conversation. It is app-clock and possibly WIDER than the loss (the proxy's
 * events carry no timestamps), never narrower — the sentence says "part of",
 * not "everything between".
 *
 * WHY 24-hour HH:MM:SS from Date getters rather than toLocaleTimeString: the
 * locale formatter's output (AM/PM, narrow no-break spaces) varies by OS and
 * ICU build, which would make the one visible sentence of this feature
 * untestable. Local time, because that is the clock the user reads.
 */
export function transportGapSentence(gap: Pick<TransportGapRecord, 'since' | 'until'>): string {
  const until = clock(gap.until)
  return gap.since === null
    ? `Part of this response was not captured (before ${until})`
    : `Part of this response was not captured (${clock(gap.since)}–${until})`
}

function clock(ms: number): string {
  const at = new Date(ms)
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}
