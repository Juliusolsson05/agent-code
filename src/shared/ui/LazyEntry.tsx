// LazyEntry — IntersectionObserver-based deferred mounting for feed entries.
//
// Entries above the viewport start as a thin placeholder. When the user
// scrolls up to them, the real content mounts. Once mounted, stays
// mounted permanently — React.memo's cached render tree survives,
// avoiding re-parse costs that virtualization (unmount/remount) would cause.

import { memo, useEffect, useRef, useState, type ReactNode } from 'react'

// The last EAGER_TAIL entries render immediately — they're in/near the
// viewport. Everything above starts lazy. 30 entries covers ~2-3
// screenfuls so the user never sees a placeholder flash on initial load.
export const EAGER_TAIL = 30

export const LazyEntry = memo(function LazyEntry({
  eager,
  scrollerRef,
  children,
}: {
  eager: boolean
  scrollerRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(eager)
  const placeholderRef = useRef<HTMLDivElement>(null)

  // If this entry starts lazy but later falls into the eager zone,
  // mount it immediately.
  useEffect(() => {
    if (eager && !mounted) setMounted(true)
  }, [eager, mounted])

  useEffect(() => {
    if (mounted) return
    const el = placeholderRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true)
          observer.disconnect()
        }
      },
      { root: scrollerRef.current, rootMargin: '200px 0px 200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, scrollerRef])

  if (!mounted) {
    return <div ref={placeholderRef} className="min-h-[48px]" />
  }

  return <>{children}</>
})
