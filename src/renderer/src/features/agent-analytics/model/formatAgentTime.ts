// Formatting for the Agent Analytics window (#964).
//
// WHY hours-and-minutes and not decimal hours: the question the window answers is
// "what did my time go to", read at a glance across many rows. "3h 12m" is how a
// person says a duration; "3.2h" makes the reader convert, and a decimal hides
// that 0.1h is six minutes. Seconds are dropped on purpose — recorded working
// time is a planning signal, and second-level precision would only add noise to
// every row.

export function formatAgentTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalMinutes = Math.floor(ms / 60_000)
  // Anything under a minute still happened; showing "0m" beside a project that
  // did run an agent would read as "nothing", which is the wrong answer.
  if (totalMinutes === 0) return '<1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** "12 Sep" style label for a local YYYY-MM-DD date. */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return date
  return new Date(year, month - 1, day).toLocaleDateString([], { day: 'numeric', month: 'short' })
}
