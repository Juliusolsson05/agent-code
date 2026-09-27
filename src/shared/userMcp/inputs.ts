// `${input:<id>}` references — VS Code's MCP secret syntax (`inputs` with
// `password: true`), adopted verbatim so a VS Code config pastes unchanged and
// so users see a syntax they may already know instead of one we invented.

const INPUT_REFERENCE = /\$\{input:([A-Za-z0-9_-]{1,64})\}/g

export const USER_MCP_INPUT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function inputReferences(value: string): string[] {
  return [...value.matchAll(INPUT_REFERENCE)].map(match => match[1]!)
}

export function hasInputReference(value: string): boolean {
  return inputReferences(value).length > 0
}

/**
 * Replace every reference with its secret value.
 *
 * Returns null when any referenced value is missing. WHY not substitute an
 * empty string: an `Authorization: Bearer ` header or an empty API key makes the
 * server fail in a confusing, server-specific way at tool-call time. Refusing
 * here lets main drop the server with an explicit "secret not set" reason
 * before the agent launches.
 */
export function substituteInputs(
  value: string,
  secrets: Readonly<Record<string, string>>,
): string | null {
  let missing = false
  const result = value.replace(INPUT_REFERENCE, (_whole, id: string) => {
    const secret = secrets[id]
    if (secret === undefined || secret === '') {
      missing = true
      return ''
    }
    return secret
  })
  return missing ? null : result
}
