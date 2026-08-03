# Meridian scope and decision index

This file records stable product scope and architecture decisions. It is not a second protocol or operations manual. The linked documents are authoritative for implementation details.

## Product scope

Meridian synchronizes one Obsidian vault across macOS and iOS through a self-hosted Cloudflare Worker. It provides:

- end-to-end encrypted notes, attachments, and selected Obsidian configuration;
- offline edits and deterministic conflict preservation;
- immutable revision history with infinite retention;
- device pairing, revocation, recovery, and signed key epochs;
- hibernating WebSocket hints with authenticated HTTP catch-up;
- local browser storage diagnostics and safe compaction.

Meridian does not provide continuous iOS background execution, collaborative live editing, server-side plaintext processing, cross-vault sharing, or backup guarantees.

## Ownership

| Concern | Owner |
| --- | --- |
| Wire formats, signing bytes, log compatibility | `packages/protocol` |
| Key lifecycle and cryptographic workflows | `packages/crypto` |
| Simulator reference model and text merge | `packages/sync-engine` |
| Independent convergence model | `packages/test-simulator` |
| Ordered metadata and authorization | one Vault Durable Object |
| Immutable encrypted chunks | private R2 bucket |
| Vault mutation and local durability | Obsidian plugin `SyncController` and journal |
| Timers, debounce, and reconnect deadlines | plugin scheduler |

The Worker and plugin import shared packages. Shared packages never import Cloudflare, Obsidian, browser UI, or runtime adapters.

## Durable decisions

### Security and compatibility

- New writes use only the current canonical protocol.
- Immutable legacy history remains readable and verifiable.
- Unsupported, partial, downgraded, or ambiguous protocol states fail closed.
- HTTP signing bytes and checkpoint format normalization have one shared implementation.
- Pairing authorization requires signed proofs and matching human verification phrases.
- Plaintext, keys, paths, and sensitive identifiers must not enter production diagnostics.

### Synchronization and recovery

- Durable Object SQLite is the only ordered remote metadata authority.
- WebSockets are hints. Authenticated HTTP polling is authoritative.
- Exact retries preserve operation envelopes, idempotency keys, blobs, cursors, and hashes.
- Vault mutations complete before their local journal effects.
- Applied journal effects commit atomically. Checkpoint advancement remains last.
- A persisted checkpoint never passes missing local state or unreadable successor key material.
- Legacy partial states remain replayable after upgrade.

### Storage

- R2 contains immutable ciphertext only.
- A revision cannot commit until every referenced blob exists and remains protected by its SQL claim.
- Cleanup installs SQL deletion fences before R2 deletion. Upload and commit paths respect those fences without globally blocking unrelated requests.
- Committed history and referenced blobs have infinite retention.
- Device retention acknowledgements are signed telemetry. They never authorize deletion.
- Local compaction deletes only completed work and exact duplicate history rows.

### Runtime ownership

- `SyncController` owns accepted vault-event writes, synchronization, maintenance serialization, quiescence, and journal lifetime.
- The scheduler owns only deadlines, debounce, and reconnect policy.
- Pairing polling has one cancellable owner and stops on plugin unload.
- Index planning has one cooperative implementation. A Blob Worker performs transferred-buffer hashing only.
- Attachment transfers use at most four concurrent chunks.

### Stable persistence versions

- Durable Object schema marker: **10**.
- IndexedDB version: **6**.
- Compatible changes reuse existing tables, stores, indexes, and metadata keys. A version change requires an explicit migration and rollback review.

## Change policy

A change to synchronization, storage, pairing, or lifecycle behavior must preserve the decisions above and add a focused regression test. Concurrency defects should be reproduced with deterministic barriers before the fix where practical. Crash changes must test the production adapter and restart from the same durable state.

Fault campaigns run on demand with deterministic seeds. Failed schedules save ordered traces and become fixed regressions after minimization.

## Authoritative documents

- [Architecture](docs/architecture.md): runtime boundaries and ownership
- [Protocol](docs/protocol.md): cryptographic and wire invariants
- [Threat model](docs/threat-model.md): assets, adversaries, and limits
- [Operations](docs/operations.md): deployment safety and incident handling
- [Testing](docs/testing.md): device, fault, and responsiveness scenarios
- [Deployment](docs/deployment.md): provisioning and upgrades
