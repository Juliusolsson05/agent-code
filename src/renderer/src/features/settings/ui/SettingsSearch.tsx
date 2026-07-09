type Props = {
  value: string
  onChange: (value: string) => void
}

export function SettingsSearch({ value, onChange }: Props) {
  return (
    <div className="border-b border-panel-border bg-canvas px-4 py-3">
      <input
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="Search settings"
        className="w-full border border-input-border bg-input-bg px-3 py-2 text-[12px] text-ink outline-none placeholder:text-input-placeholder focus:border-input-border-focus"
      />
    </div>
  )
}
