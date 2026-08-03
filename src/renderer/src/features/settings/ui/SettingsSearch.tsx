import { Input } from '@renderer/components/ui/input'

type Props = {
  value: string
  onChange: (value: string) => void
}

// The raw <input> this replaced carried a hand-copy of Input's own class list
// — same tokens, same order, differing only in `py-2` instead of `h-8` and a
// missing focus ring. Keeping the copy meant the search field silently drifted
// away from every other field in the app whenever Input changed.
export function SettingsSearch({ value, onChange }: Props) {
  return (
    <div className="border-b border-panel-border bg-canvas px-4 py-3">
      <Input
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="Search settings"
      />
    </div>
  )
}
