# Extension platform final-review cleanup (#1156)

The last cleanup round after #1146, #1148 and #1151. It depends on SDK PR
Juliusolsson05/agent-code-extension-api#6, which exports
`TRANSPORT_ATTESTATION_HEADER` and makes `api.secrets` optional. The submodule
is pinned to that PR's head. **After SDK #6 merges, re-pin to its merge commit
before this PR merges.**

## Decisions

1. **One request-shape rule set.**
   - `NET_FETCH_METHODS` and `MAX_NET_FETCH_HEADERS` live in
     `@shared/types/extensionServices`, because the zod schema is in shared and
     cannot import main.
   - `assertFetchRequestShape` (verb, body bytes, header count, host-reserved
     headers) sits next to `buildRequestHeaders` in `netFetch.ts`.
   - `assertFetchableTarget(url, guards)` and
     `assertDeclaredOriginTarget(url, origins)` keep only the URL rules. That
     includes the userinfo refusal, which is now on both routes.
   - The service proxy uses `NET_FETCH_METHODS` too: it is the same "plain
     verbs, no CONNECT/TRACE/upgrade" set.
2. **Secrets:** `isValidExtensionId`, plus `SECRET_KEY_PATTERN` and
   `MAX_SECRET_VALUE_LENGTH` exported from shared types for both the zod schema
   and `secrets.ts`.
3. **Stale comments** in frameProtocol, netOrigins and netFetch are rewritten.
   The envelope schema becomes `frameRequestCorrelationSchema.extend({ request })`.
4. **Bridge parity.** One JS source snippet, `NET_FETCH_ARGS_JS`, builds the
   omit-empty `net.fetch` args and is interpolated into BOTH bootstraps, so the
   two can no longer drift. The test evaluates the snippet directly and checks
   that both documents embed it. The `init.method` alias comment names its
   removal condition and links #1157.
5. **Header policy names:** `PROXY_FORWARDED_HEADERS` and
   `LAN_FORWARDED_HEADERS`, each with a one-line response-header policy. The
   attestation header name is imported from the SDK dist (one source across
   repos).
6. **Redirects:** the 3xx check moves into `boundedFetchResult`.
   `transportFailure` recognises undici's "unexpected redirect" cause. Both
   routes give `net.fetch to <origin> was redirected; redirects are not followed.`
7. **capabilityService:** `requireGrantFor` returns
   `{ check, netRoute }`. The cached `GrantCheck` is not mutated, because its
   identity is the revocation token. The 'Unroutable' guard goes away:
   `REQUIRED_CAPABILITY` is typed so `net.fetch` is the only `'by-target'`
   entry, and it is branched on by method.
8. **Docs:** the authoring.md §6e example feature-detects `api.secrets` and
   handles null.
9. **Consumer-neutral** comments and fixtures: `api.example.com`,
   `example.service`, `example.apiKey` and extension id `example`.
10. **Tests:**
    - label the TLS test as a tripwire;
    - remove the duplicate streamed-cap test from netOrigins (the shared
      reader is covered in netFetch);
    - trim frameProtocol.test.ts to the one contract zod alone does not state:
      every method the view bootstrap exposes is in the frame allow-list.

Verification: `npx tsc -b`, targeted vitest on Node 24, and CI.
