# Meridian Worker

The Worker is the untrusted encrypted sync relay for one vault. Hono owns the public HTTP boundary. `VaultDurableObject` owns claim state, device authorization, ordered metadata, and cursor notifications. R2 stores immutable ciphertext only.

## Authentication

Device sessions use `Authorization: Bearer <session>`. Browser WebSockets may instead negotiate protocols `meridian.v1,bearer.<session>` so credentials do not appear in URLs. WebSocket messages are cursor hints; clients must reconcile over `GET /v1/changes`.

HTTP setup, authentication, operation, pairing, and revocation requests use domain-separated deterministic length-prefixed signing bytes exported by `src/vault-do.ts`. Encrypted vault operations, certificates, recovery claims, epochs, and checkpoints use the shared canonical-CBOR protocol package.

Recovery exposes only the authenticated encrypted recovery package and a bounded short-lived challenge. A valid recovery-root signature registers a fresh owner certificate and rotated epoch package, then atomically revokes all previous devices and sessions.

## Local validation

From the repository root:

```sh
bun install --frozen-lockfile
(cd worker && bun run typecheck)
(cd worker && bun run test)
bun run deploy:dry
```

`SETUP_TOKEN` must be a high-entropy secret of at least 32 characters. Never put it in source control or a setup link.
