type Props = {
  value: string
  onChange: (value: string) => void
}

export function SettingsSearch({ value, onChange }: Props) {
  return (
    <div className="border-b border-border bg-canvas px-4 py-3">
      <input
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="Search settings"
        className="w-full border border-border bg-canvas px-3 py-2 text-[12px] text-ink outline-none placeholder:text-muted focus:border-border-hi"
      />
    </div>
  )
}
