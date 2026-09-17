import { useLayoutEffect, useRef, useState } from 'react'

/** Measured pixel width of a container.
 *
 * WHY charts draw in real pixels instead of a stretched viewBox: the previous
 * charts used `viewBox="0 0 600 112"` scaled to any width, which squashes text
 * and makes a 1px hit target a different size on every screen. Axis labels
 * and a precise hover need true coordinates. `fallback` covers the first paint
 * and test DOMs that report zero layout. */
export function useElementWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width)
      if (next > 0) setWidth(current => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}
