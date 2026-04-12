// UserBand — subtle background highlight behind user prompt entries.
// Both providers use this to visually distinguish user messages from
// assistant output without bubbles or cards.

import type { ReactNode } from 'react'

export function UserBand({ children }: { children: ReactNode }) {
  return (
    <div className="bg-user-bg -mx-8 px-8 py-3">
      {children}
    </div>
  )
}
