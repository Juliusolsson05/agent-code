const SHA8_PREFIX_BYTES = 4

export function sha8FromDigestBytes(digest: Uint8Array): string {
  // The journals historically store exactly the first four SHA-256 digest bytes
  // as eight lowercase hex chars. That width is a privacy/correlation tradeoff:
  // enough entropy to pair renderer and main events inside one debug session,
  // not enough payload material to reconstruct user content. Keep this helper
  // as the single width authority so future forensic changes do not silently
  // make renderer and main fingerprints incomparable.
  const hex: string[] = []
  for (const b of digest.subarray(0, SHA8_PREFIX_BYTES)) {
    hex.push(b.toString(16).padStart(2, '0'))
  }
  return hex.join('')
}

export async function sha8Web(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return sha8FromDigestBytes(new Uint8Array(digest))
}
