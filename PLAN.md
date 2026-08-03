# Meridian scope and decisions

This file lists stable product and architecture decisions. Linked documents give the full rules.

## Product scope

Meridian syncs one Obsidian vault across macOS and iOS through a self-hosted Cloudflare Worker. It provides:

- End-to-end encryption for notes, attachments, paths, metadata, and selected settings
- Offline edits and deterministic conflict preservation
- Visible immutable revision history with infinite retention and a bounded sync log
- Pairing, revocation, recovery, and signed key epochs
- WebSocket hints with authenticated HTTP catch-up
- Advanced technical status, privacy-safe logs, storage details, and safe compaction

It does not provide continuous iOS background work, live group editing, server-side plaintext work, cross-vault sharing, or backups.

## Ownership

| Concern | Owner |
| --- | --- |
| Wire formats, signing bytes, log compatibility | `packages/protocol` |
| Keys and cryptographic workflows | `packages/crypto` |
| Reference sync model and text merge | `packages/sync-engine` |
| Independent convergence model | `packages/test-simulator` |
| Public HTTP routes and Schema decoding | Hono Worker |
| Ordered metadata, authorization, typed RPC | One Vault Durable Object |
| Immutable encrypted chunks | Private R2 bucket |
| Vault changes and local durability | Plugin `SyncController` and journal |
| Timers, debounce, reconnect deadlines | Plugin scheduler |

Shared packages never import Cloudflare, Obsidian, browser UI, or runtime adapters.

## Stable decisions

### Security and compatibility

- New writes use only the current canonical protocol.
- Immutable legacy history stays readable and verifiable.
- Unsupported, partial, downgraded, or ambiguous states fail closed.
- HTTP signing bytes and checkpoint normalization have one shared implementation.
- Hono owns normal HTTP decoding and formatting.
- The Durable Object owns typed RPC, SQL authentication, and transactions.
- `VaultDurableObject.fetch()` handles WebSocket upgrades only.
- Pairing needs signed proofs and matching human verification phrases.
- Production logs must not contain plaintext, keys, recovery data, paths, envelope bodies, or unnecessary stable identifiers.

### Sync and recovery

- Durable Object SQLite is the only authority for ordered remote metadata.
- WebSockets are hints. Authenticated HTTP polling is authoritative.
- Exact retries keep operation envelopes, idempotency keys, blobs, cursors, and hashes.
- Each vault change finishes before its local journal effects.
- Applied journal effects commit atomically. The checkpoint advances last.
- A saved checkpoint never passes missing local state or unreadable next-epoch keys.
- Old partial states remain replayable after an upgrade.

### Storage

- R2 stores immutable ciphertext only.
- A revision commits only after all referenced blobs exist and SQL claims protect them.
- Cleanup creates SQL deletion fences before R2 deletion.
- Uploads and commits obey the fences without blocking unrelated requests.
- Committed history and referenced blobs have infinite retention.
- Signed device retention acknowledgements are telemetry only. They never allow deletion.
- Local compaction deletes only completed work and exact duplicate history rows.

### Product and runtime

- Normal settings show connection, device management, and configuration sync only.
- Polling, full scans, and mobile-safe file limits use internal automatic policy.
- Meridian syncs every eligible vault file. It refuses to start if an upgrade still contains old exclusion rules.
- History and the sync log stay visible. Technical status, storage, logs, and repair live under Troubleshooting.
- `SyncController` owns accepted vault-event writes, sync, serialized maintenance, quiescence, and journal lifetime.
- The scheduler owns only deadlines, debounce, and reconnect policy.
- One cancellable owner controls pairing polls. Polling stops on plugin unload.
- One cooperative implementation plans the index. A Blob Worker only hashes transferred buffers.
- Attachment transfers use at most four concurrent chunks.

### Storage versions

| Storage | Version |
| --- | ---: |
| Durable Object schema marker | **10** |
| IndexedDB | **6** |

Compatible changes reuse current tables, stores, indexes, and metadata keys. Version changes need a migration and rollback review.

## Change rules

A sync, storage, pairing, or lifecycle change must preserve these decisions and add a focused regression test. Reproduce concurrency defects with deterministic barriers when practical. Crash changes must test the production adapter and restart from the same durable state.

Fault campaigns use deterministic seeds. Failed schedules save ordered traces. Minimized failures become fixed regression tests.

## Full documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Threat model](docs/threat-model.md)
- [Operations](docs/operations.md)
- [Testing](docs/testing.md)
- [Deployment](docs/deployment.md)
