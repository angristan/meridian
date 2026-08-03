# Meridian Worker

The Worker is an untrusted encrypted sync relay for one vault.

```text
Public request
    ↓
Hono: route, bound body size, decode, respond
    ↓ typed RPC
VaultDurableObject: authenticate and update SQLite
    ↘
      R2: immutable ciphertext chunks
```

## Boundaries

Hono owns:

- public HTTP routes;
- bounded request-body reads;
- Effect Schema decoding;
- HTTP responses.

Normal vault calls use typed remote procedure calls (RPC). This means that Hono calls named `VaultDurableObject` methods with checked inputs. The Durable Object `fetch()` handler is reserved for hibernating WebSocket upgrades.

The Durable Object owns SQL authentication, claim state, device authorization, ordered metadata, and cursor notifications. R2 stores immutable ciphertext only.

Ship the Hono RPC caller and Durable Object class in the same Worker version. For gradual deployment, keep RPC calls compatible between versions. Otherwise, route each request to one code version from start to finish.

## Authentication

Device HTTP sessions send:

```http
Authorization: Bearer <session>
```

Browser WebSockets can instead negotiate these protocols:

```text
meridian.v1,bearer.<session>
```

This keeps credentials out of URLs. WebSocket messages are cursor hints only. Clients must get authoritative changes from `GET /v1/changes`.

HTTP requests for setup, authentication, operations, pairing, and revocation use domain-separated, deterministic, length-prefixed signing bytes. These bytes are exported by `src/vault-do.ts`.

Encrypted vault operations, certificates, recovery claims, epochs, and checkpoints use the shared canonical-CBOR protocol package.

Recovery exposes only:

- the authenticated encrypted recovery package;
- a small, short-lived challenge.

A valid recovery-root signature registers a new owner certificate and rotated epoch package. The same atomic action revokes all old devices and sessions.

## Validate locally

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
(cd worker && bun run typecheck)
(cd worker && bun run test)
bun run deploy:dry
```

## Setup secret

`SETUP_TOKEN` must be a high-entropy secret with at least 32 random bytes.

> Never put it in source control, logs, screenshots, support messages, or a setup link.
