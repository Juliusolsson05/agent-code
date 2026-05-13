// System-perf byte formatter.
//
// WHY SI units (1e9 / 1e6) and not binary (GiB / MiB / KiB): every
// caller in the renderer compares its readout against macOS Activity
// Monitor, which is SI. Off by ~7% from binary, but in line with what
// the user actually sees in the OS-level monitor. Don't switch to
// binary without changing every caller's surrounding label first.
//
// WHY a tunable `fractionDigits`: the badge in the header is
// space-constrained (single line, fixed width) so it prefers integer
// MB/KB readings. The popover has room for more precision on the
// GB axis. The split used to live in two separate copies of this
// function (badge had no arg, popover had a `fractionDigits = 2`
// default) — folded here with the same `2` default so badge callers
// just pass nothing.

export function formatBytes(bytes: number, fractionDigits = 2): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(fractionDigits)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}
