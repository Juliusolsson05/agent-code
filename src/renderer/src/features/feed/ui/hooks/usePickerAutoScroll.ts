import { useEffect, useRef, type RefObject } from 'react'

// PORTED VERBATIM from Feed.tsx:591-710 @269f9fc — the two picker
// auto-scroll effects (Copy Assistant Message + Copy Code Block). This
// logic is scarred; read the WHY comments before changing anything.
//
// WHY the tween is custom rAF and not native scrollIntoView:
//   - With block:'nearest' scrollIntoView no-ops when the target is
//     already on screen, so rapid arrow presses after a manual scroll
//     land on already-visible entries and produce zero motion (user
//     report: "my arrow key does nothing after I scroll").
//   - With block:'center' native smooth scroll was observably shaky —
//     the feed's own scroll listener fires on every frame of the
//     animation and was fighting the browser's scroll queue.
//   A custom rAF tween is ~20 lines, interrupt-safe (new target
//   cancels any in-flight animation), and completely independent of
//   whatever the scroll listener is doing.
//
// WHY this hook RETURNS cancelTween: the scroll-to-latest behavior in
// useScrollFeedBehaviors must cancel an in-flight picker tween before
// snapping to the bottom (Feed.tsx:712-728 did this by sharing the
// ref). Returning a stable canceller keeps the animation-frame ref
// owned HERE while giving the scroll hook its one legitimate touch
// point — the alternative (a shared ref threaded through Feed) spreads
// tween ownership across files, which is how the two pickers drifted
// apart in the first place.

const OUTLINE_CLASSES = ['outline', 'outline-2', 'outline-accent', 'outline-offset-2']

export function usePickerAutoScroll({
  scrollerRef,
  pickerSelectedUuid,
  codeBlockSelectedId,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  pickerSelectedUuid: string | null
  codeBlockSelectedId: string | null
}): { cancelTween: () => void } {
  const scrollAnimFrameRef = useRef<number | null>(null)
  // Stable canceller — identity never changes, safe as an effect dep.
  const cancelTweenRef = useRef(() => {
    if (scrollAnimFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimFrameRef.current)
      scrollAnimFrameRef.current = null
    }
  })

  // Shared tween runner for both pickers. Duration/easing preserved
  // exactly from the original (180ms easeOutCubic).
  const tweenTo = (root: HTMLElement, target: HTMLElement) => {
    const targetCenter = target.offsetTop + target.offsetHeight / 2
    const desired = targetCenter - root.clientHeight / 2
    const maxScroll = root.scrollHeight - root.clientHeight
    const to = Math.max(0, Math.min(maxScroll, desired))
    const from = root.scrollTop
    const distance = to - from
    if (Math.abs(distance) < 1) return

    cancelTweenRef.current()

    const duration = 180
    const startTime = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3) // easeOutCubic

    const step = (now: number) => {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / duration)
      root.scrollTop = from + distance * ease(t)
      if (t < 1) {
        scrollAnimFrameRef.current = requestAnimationFrame(step)
      } else {
        scrollAnimFrameRef.current = null
      }
    }
    scrollAnimFrameRef.current = requestAnimationFrame(step)
  }

  // Copy Assistant Message picker — center the selected entry.
  useEffect(() => {
    if (!pickerSelectedUuid) return
    const root = scrollerRef.current
    if (!root) return
    const target = root.querySelector(
      `[data-entry-uuid="${pickerSelectedUuid}"]`,
    ) as HTMLElement | null
    if (!target) return
    tweenTo(root, target)
    return () => cancelTweenRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tweenTo reads refs only
  }, [pickerSelectedUuid])

  // Copy Code Block picker — outline + center the selected block.
  //
  // WHY the outline is applied imperatively rather than as a JSX class:
  // the assistant picker highlights an ENTRY, and Feed renders a
  // wrapper <div data-entry-uuid> per entry it can class in JSX. A code
  // block is buried deep inside rendered markdown / tool rows — there
  // is no per-block wrapper Feed controls. So we locate the block by
  // `data-code-block-id` and toggle classes on the node directly.
  // The class list matches the entry picker's outline exactly, so
  // Tailwind's static scan already emits the CSS.
  useEffect(() => {
    if (!codeBlockSelectedId) return
    const root = scrollerRef.current
    if (!root) return
    const target = root.querySelector(
      `[data-code-block-id="${codeBlockSelectedId}"]`,
    ) as HTMLElement | null
    if (!target) return

    target.classList.add(...OUTLINE_CLASSES)
    tweenTo(root, target)

    return () => {
      target.classList.remove(...OUTLINE_CLASSES)
      cancelTweenRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tweenTo reads refs only
  }, [codeBlockSelectedId])

  return { cancelTween: cancelTweenRef.current }
}
