import { useCallback, useEffect, useState } from 'react'

type Props = {
  prompt: {
    sessionAgeText?: string
    tokenCountText?: string
    selectedIndex?: number
  } | null
  onSend: (data: string) => Promise<void>
}

const DEFAULT_OPTIONS = [
  'Resume from summary (recommended)',
  'Resume full session as-is',
  "Don't ask me again",
]

function moveSelection(current: number, target: number): string {
  if (target === current) return '\r'
  const step = target > current ? '\x1b[B' : '\x1b[A'
  return step.repeat(Math.abs(target - current)) + '\r'
}

export function ResumePromptModal({ prompt, onSend }: Props) {
  const [localSelected, setLocalSelected] = useState(0)

  useEffect(() => {
    if (prompt?.selectedIndex != null) {
      setLocalSelected(prompt.selectedIndex)
    }
  }, [prompt?.selectedIndex])

  useEffect(() => {
    if (prompt) setLocalSelected(prompt.selectedIndex ?? 0)
  }, [prompt?.sessionAgeText, prompt?.tokenCountText, prompt?.selectedIndex])

  const options = DEFAULT_OPTIONS

  const confirm = useCallback(() => {
    void onSend('\r')
  }, [onSend])

  const cancel = useCallback(() => {
    void onSend('\x1b')
  }, [onSend])

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        void onSend('\x1b[A')
        setLocalSelected(prev => Math.max(0, prev - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        void onSend('\x1b[B')
        setLocalSelected(prev => Math.min(options.length - 1, prev + 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        confirm()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [prompt, options.length, confirm, cancel, onSend])

  if (!prompt) return null

  return (
    <div className="
      flex-shrink-0
      border-t border-border
      bg-surface
      px-5 py-3
      font-code text-[12px] leading-[1.65]
    ">
      <div className="text-ink font-semibold mb-2">
        This session is {prompt.sessionAgeText ?? 'older'} old and {prompt.tokenCountText ?? 'many'} tokens.
      </div>

      <div className="text-ink-dim mb-2">
        Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.
      </div>

      <div className="flex flex-col gap-0.5 mb-2">
        {options.map((opt, i) => (
          <div
            key={i}
            className={`cursor-pointer ${i === localSelected ? 'text-ink' : 'text-ink-dim'}`}
            onClick={() => {
              const current = prompt.selectedIndex ?? localSelected
              setLocalSelected(i)
              void onSend(moveSelection(current, i))
            }}
          >
            <span className={`select-none ${i === localSelected ? 'text-accent' : 'text-transparent'}`}>
              ❯{' '}
            </span>
            {i + 1}. {opt}
          </div>
        ))}
      </div>

      <div className="text-muted text-[10px]">
        Press enter to confirm or esc to cancel
      </div>
    </div>
  )
}
