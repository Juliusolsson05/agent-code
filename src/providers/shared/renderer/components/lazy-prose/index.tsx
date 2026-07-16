import { lazy, Suspense } from 'react'

// Provider capability registries are imported by headless evidence/replay
// code as well as the browser renderer. A static TextProse import reaches the
// Markdown code-block stack, which initializes browser theme state and touches
// `document` at module load. That made adding a rich provider result break
// otherwise DOM-free replay tests. Dynamic import keeps the registry graph
// headless-safe and also matches the UX contract: prose is requested only
// after the owning disclosure has opened.
const DeferredTextProse = lazy(async () => {
  const module = await import('@renderer/features/feed/ui/markdown')
  return { default: module.TextProse }
})

export function LazyTextProse({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <div className="text-muted text-[11px]" role="status">
          Formatting content…
        </div>
      }
    >
      <DeferredTextProse text={text} />
    </Suspense>
  )
}
