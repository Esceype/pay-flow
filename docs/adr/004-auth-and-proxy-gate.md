# ADR-004: Minimal auth for Phase 1, and why there's no `proxy.ts` auth gate

## Context

The original phased plan didn't schedule an authentication phase — it listed
NextAuth.js in the tech stack but never said when to wire it up. Phase 1
(Stripe Connect onboarding) surfaced the gap directly: Connect OAuth has to
attach the resulting `stripeAccountId` to a specific `User`, which requires
knowing who's currently signed in *before* Connect onboarding can exist at
all.

## Decision: Credentials + JWT sessions, not OAuth/magic-link

Auth.js (`next-auth@5`) with:

- **Credentials provider** (email + password), not an OAuth or magic-link
  provider. An OAuth provider (e.g. GitHub) would need its own registered
  app; a magic-link provider needs working transactional email (Resend
  isn't wired up until a later phase). Credentials has no external
  dependency and keeps Phase 1 scoped to what it's actually about —
  Connect — rather than pulling in email delivery early.
- **JWT sessions**, not database sessions. Auth.js does not support
  database sessions with the Credentials provider (Credentials sign-in
  isn't compatible with the adapter-driven session flow), so this wasn't
  really a choice. The upside: no NextAuth `Account`/`Session`/
  `VerificationToken` tables — `User` (already tenant-shaped) is the only
  auth-related table.
- **Password hashing via Node's built-in `crypto.scrypt`**, not
  bcrypt/bcryptjs. Avoids a native-binding dependency that needs compiling
  inside the Alpine-based Docker images, and scrypt is a sound KDF on its
  own merits (`src/lib/password.ts`).

## Decision: no `proxy.ts` auth gate — per-route session checks only

Next.js 16 renamed `middleware.ts` to `proxy.ts` (see AGENTS.md). Auth.js
v5's documented middleware pattern —
`export default auth((req) => { ... })` — is what its own docs recommend for
gating protected routes at the edge/proxy layer.

That pattern was implemented, and it broke every request in the Docker
container at runtime:

```
⨯ [Error: The Proxy file "/proxy" must export a function named `proxy` or a default function.]
```

The build succeeds; only `next start` fails, on every request. Root cause:
`next-auth@5.0.0-beta.32` predates Next.js 16's proxy rename, and whatever
wrapped function `auth(callback)` returns isn't recognized by Next 16's
newer, stricter proxy-file loader as a valid function export — an interop
gap between a beta auth library and a brand-new framework convention,
not a mistake in how it was called (this matches the library's own
documented pattern verbatim).

**Options considered:**

- **A — chase the interop bug**: try `next-auth/jwt`'s `getToken()` for a
  manual, framework-arbitrary token check inside a hand-written
  `export async function proxy()`. Auth.js's own type docs flag this path
  "not recommended" in v5 in favor of the (currently broken) `auth()`
  wrapper.
- **B — drop the proxy gate entirely**, rely on session checks inside each
  protected route/page.

**Chose B.** Next's own proxy documentation already warns against relying on
the proxy layer as the sole gate:

> A matcher change or a refactor that moves a Server Function to a different
> route can silently remove Proxy coverage. Always verify authentication and
> authorization inside each Server Function rather than relying on Proxy
> alone.

Every protected surface already does this independently: `dashboard/page.tsx`,
`api/connect/start/route.ts`, and `api/connect/callback/route.ts` each call
`auth()` and redirect to `/login` if there's no session. Removing `proxy.ts`
costs a UX nicety (redirect happens after the route starts executing rather
than before), not actual protection — verified by curling `/dashboard` and
`/api/connect/start` with no session cookie and confirming both 307 to
`/login`.

## Consequences

- Every new protected route must remember to check `auth()` itself — there
  is no fallback gate. This is more error-prone than a single proxy
  matcher, traded deliberately for not depending on a currently-broken
  interop path.
- Revisit `proxy.ts` once `next-auth` ships a stable release with confirmed
  Next.js 16 proxy support — check their changelog before re-attempting the
  `auth(callback)` pattern.
