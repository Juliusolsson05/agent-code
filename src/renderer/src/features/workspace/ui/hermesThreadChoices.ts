import type { HermesLaneChoice } from '@shared/hermes/types'
import { relativeTime } from '@renderer/lib/relativeTime'

// The rows of "Change Telegram Thread…" (#1501), as a pure function of the
// server's lane listing so the labelling rule is tested on the RECORDED
// listing (hermes-headless corpus T8) rather than on literals.
//
// WHY the label leads with WHICH THREAD and not whose: in the recorded T8 the
// plain DM and its topic carry the SAME display name ("Tester" for both:
// Hermes stores the chat's name, and a topic is the same chat). A
// name-first label made two identical rows, so the user could not tell the
// thread they were leaving from the one they were picking.

export type HermesThreadChoice = {
  /** The routing key to follow, or null for "Separate chat". */
  laneKey: string | null
  label: string
  description: string
  current: boolean
}

export function hermesThreadChoices(
  lanes: readonly HermesLaneChoice[],
  currentLaneKey: string | null,
  /**
   * False while the listing loads or after it failed. Then an empty `lanes`
   * says nothing about the server, and the current-thread row must not claim
   * the thread is gone from it (review of #1521, L1).
   */
  listed = true,
  now: number = Date.now(),
): HermesThreadChoice[] {
  const rows: HermesThreadChoice[] = [
    {
      laneKey: null,
      label: 'Separate chat',
      // What the user gives up, said plainly: the lane rows are the ones the
      // phone sees, this one is not.
      description: 'A conversation only Agent Code shows. It does not appear in Telegram.',
      current: currentLaneKey === null,
    },
  ]
  for (const lane of lanes) {
    rows.push({
      laneKey: lane.sessionKey,
      label: laneLabel(lane),
      description: laneDescription(lane, now),
      current: lane.sessionKey === currentLaneKey,
    })
  }
  // The pane may follow a thread the listing no longer returns (the REST
  // listing is the 100 most recent rows; an idle thread falls off it).
  // Showing no "Current" mark at all would read as "this pane follows
  // nothing", so keep it as its own row the user can stay on.
  if (currentLaneKey !== null && !lanes.some((lane) => lane.sessionKey === currentLaneKey)) {
    rows.splice(1, 0, {
      laneKey: currentLaneKey,
      label: 'Current thread',
      description: listed ? 'Not in the server’s recent threads.' : 'The thread this pane follows now.',
      current: true,
    })
  }
  return rows
}

export function laneLabel(lane: HermesLaneChoice): string {
  const platform = lane.platform === 'telegram' || !lane.platform ? '' : `${titleCase(lane.platform)} · `
  const name = lane.displayName?.trim() || null
  const where = lane.chatType === 'dm'
    ? (lane.threadId === null ? 'Direct chat' : `Direct chat topic ${lane.threadId}`)
    : `${lane.chatType ? titleCase(lane.chatType) : 'Chat'}${lane.threadId === null ? '' : ` topic ${lane.threadId}`}`
  return `${platform}${where}${name ? ` · ${name}` : ''}`
}

function laneDescription(lane: HermesLaneChoice, now: number): string {
  // lastActiveAt is SECONDS on the server's clock (LaneSummary); relativeTime
  // takes local millis. Skew between the two clocks only shifts "5m ago".
  const active = lane.lastActiveAt ? `Active ${relativeTimeAt(lane.lastActiveAt * 1000, now)}` : 'No activity yet'
  return `${active} · ${lane.sessionKey}`
}

function relativeTimeAt(ts: number, now: number): string {
  // relativeTime reads Date.now(); shift the timestamp so a test (and a
  // caller passing `now`) gets the same answer for the same pair.
  return relativeTime(ts + (Date.now() - now))
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
