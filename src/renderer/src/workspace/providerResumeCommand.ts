export type ResumableProviderKind = 'claude' | 'codex'

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildProviderResumeCommand(
  kind: ResumableProviderKind,
  cwd: string,
  providerSessionId: string,
): string {
  // WHY this helper is renderer-owned instead of a generic shared shell helper:
  // the duplicate call sites were not trying to build arbitrary commands; they
  // were encoding the provider resume contract shown to the user in copyable
  // prompt text. Keeping the scope narrow avoids inviting unrelated shell
  // construction while still making the Claude `--resume` vs Codex `resume`
  // subcommand split one source of truth.
  const cd = `cd ${shellQuote(cwd)}`
  const resume = kind === 'codex'
    ? `codex resume ${shellQuote(providerSessionId)}`
    : `claude --resume ${shellQuote(providerSessionId)}`
  return `${cd} && ${resume}`
}
