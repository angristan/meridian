# Architecture

Meridian keeps protocol rules separate from Cloudflare and Obsidian code.

```text
worker ---------> packages/crypto --------> packages/protocol
                        ^                         ^
obsidian-plugin -------'                         |
       `------------> packages/sync-engine ------'

Worker --> one Vault Durable Object --> SQLite metadata
       `-----------------------------> private R2 ciphertext
```

## Safety boundaries

- Durable Object SQLite is the only authority for ordered remote metadata.
- R2 stores immutable encrypted chunks only.
- The plugin owns plaintext vault changes and local durability.
- WebSockets are hints. Authenticated HTTP pull is authoritative.

See [Protocol](protocol.md) for wire and cryptographic rules.

## Shared packages

- `packages/protocol` owns wire formats, typed identifiers, HTTP signing bytes, log rules, and downgrade policy.
- `packages/crypto` owns key lifecycle, certificates, pairing, recovery, and encrypted revisions.
- `packages/sync-engine` owns the reference sync model and production text merge.
- `packages/test-simulator` tests convergence and no silent data loss independently.

Dependencies point toward these packages. They never import Worker, Cloudflare, Obsidian, or browser UI code.

## Worker

`worker/src/index.ts` connects the Worker with Hono. Modules in `worker/src/http/` own public routes, bounded body reads, Effect Schema decoding, responses, setup checks, R2 streaming, and WebSocket upgrades.

Normal vault calls use typed remote procedure calls (RPC). This means that the Worker calls named methods on the Durable Object. `VaultDurableObject.fetch()` handles WebSocket upgrades only because upgrades need its `Request` and `Response` behavior.

One `VaultDurableObject` coordinates the deployment. Its RPC methods take validated values and session tokens. They return plain success or error values. Its SQL checks are authoritative for authentication and revocation.

| Module | Owns |
| --- | --- |
| `vault/setup.ts`, `sessions.ts`, `recovery.ts` | Identity lifecycle |
| `vault/pairing.ts` | Devices and pairing |
| `vault/operations.ts` | Ordered, safe-to-retry log and revocation |
| `vault/records.ts` | Checkpoints and snapshots |
| `vault/notifications.ts` | Hibernating WebSockets |
| `vault/migrations.ts` | Ordered SQLite migrations |
| `vault/signing.ts` | Adapters for shared signing bytes |

The Durable Object owns authoritative transactions. Domain modules get decoded values and explicit SQLite and transaction access. They do not parse HTTP, create separate state, or add locks. Hono maps results to current public status codes and JSON errors.

## Obsidian plugin

`src/main.ts` connects the plugin. `src/plugin/` owns settings, protocol handlers, secret names, vault events, resume behavior, and scheduling.

```text
SyncController
  |-- Reconciler
  |-- PullEngine --> OperationApplier --> RevisionLoader
  |-- PushEngine
  `-- HistoryService --> RevisionLoader
```

- `src/crypto/` owns device, pairing, revision, and Worker wire workflows.
- `src/network/` owns the portable client, response parsing, one-shot WebSockets, and transports.
- `src/storage/` owns contracts, IndexedDB, memory tests, migrations, and helpers.
- `src/ui/` owns status, settings, history, the sync log, devices, recovery, conflicts, and advanced troubleshooting.

A stateless typed object provides `CryptoPort`. The scheduler owns reconnect timing. Consumers import owner modules directly.

## Crash-safe key changes

A key epoch is one key generation. One SQLite transaction commits the transition, epoch ID and sequence, recovery-package update, and pairing fence. The recovery update succeeds only if the old state still matches. The signed transition has one encrypted key package for each active device.

SecretStorage is the authority for keys. IndexedDB stores a recoverable log cursor.

```text
verify --> decrypt key --> replace full secret
       --> invalidate old prepared ciphertext --> advance cursor
```

A crash before secret replacement keeps the old cursor. The transition replays. A crash after replacement but before cursor advance replays safely with the next keyring. The cursor never passes an unreadable next secret. Prepared plaintext stays available for encryption with the next epoch.

## Remote storage safety

Committed history has infinite retention. Signed acknowledgements report each active device's durable cursor, hash, and epoch. They are status data only. The client signs again only after its accepted checkpoint or epoch changes. Acknowledgements cannot allow truncation without an authenticated archive and a safe way to restart a device from it.

```text
request --> SQL upload claim --> immutable R2 PUT --> confirmation
                                                        |
operation commit <-------- every blob required ----------'
```

The Durable Object reconciles its R2 blob catalog during storage inspection. Upload and temporary commit claims protect in-flight blobs from cleanup.

Cleanup installs a SQL deletion fence before R2 deletion. Commits reserve blobs before waiting for R2. These fences do not block unrelated requests or WebSockets. A revision commits only after every blob is confirmed in R2 and its claim is checked again in the operation transaction.

A crash can leave a fence after R2 deletion. The next upload confirms that the object is absent. It atomically changes the fence into a new upload claim.

Uploads and downloads use at most four concurrent chunks. A started revision upload reaches its commit boundary before pause.

## Local storage safety

Compaction deletes only completed uploads and history rows that exactly duplicate retained revision rows. Each transaction does at most 500 deletions. It keeps pending work, dirty tokens, revision graph ancestry, conflicts, checkpoints, revocations, and file history.

Revision stores have `fileId` indexes. The legacy stable-ID migration saves one atomic completion marker. It does not rescan on every start.

The journal loads one immutable snapshot index when it opens. It updates the index only after successful IndexedDB transactions. This avoids repeated `files.getAll()` reads.

A pushed revision, snapshot changes, and completed journal entry commit together. A pulled revision, snapshot and conflict changes, and affected entries also commit together. The checkpoint advances later, after all local effects are durable.

Pull replay repairs matching prepared state before checkpoint advance. A lost server reply can leave a committed outgoing entry pending after that checkpoint. An exact retry completes it without a duplicate. If a later pull directly descends from it, Meridian completes the pending entry before it can report a false conflict.

## Local indexing

Vault events are grouped by normalized path in the IndexedDB `dirty-paths` store. Routine event and notification sync checks only those paths. Journal entries, snapshots, and consumed event tokens commit together. An event replaced during reconciliation stays queued.

Startup, resume, manual sync, settings changes, repair, and periodic sync still scan every eligible vault file. This recovers missed events, direct file changes, and plugin downtime.

Meridian has no selective-sync controls. Every eligible vault file is synchronized.

Meridian refuses to start if saved settings still contain old exclusion rules. The user must clear those rules and complete a sync with Meridian 1.11.13 before upgrading. This fail-closed step prevents skipped remote heads, unexpected uploads, and false deletions.

```text
vault events --> durable dirty paths --> targeted hash ----.
startup or periodic metadata scan ------------------------+--> plan
complete daily fingerprint audit -------------------------'

Editor: Vault API reads and writes, then final state check
Worker: SHA-256 of transferred buffers only
Planner: collision, removal, and rename work with bounded yields
```

Startup and periodic scans reuse a fingerprint when path, size, modification time, and file kind match. Other files are read and hashed. If the full path and fingerprint index is unchanged, Meridian skips rename and collision planning after a linear collision check. A daily full audit finds same-size changes with unchanged timestamps.

The Blob Worker hashes transferred buffers away from the editor. It never calls Obsidian APIs. One cooperative planner works on all platforms. Platforms that reject Blob Workers hash on the main thread.

Pause and unload stop pending Worker work. Dirty event tokens stay recoverable. Index repair and sync share one maintenance owner, so repair cannot clear the live index during reconciliation.

## Scheduling and mobile

One deadline timer replaces periodic scheduler ticks. Edit bursts wait 1.5 seconds and combine for at most five seconds. Meridian tries to flush a pending batch when the app becomes hidden.

Meridian chooses timing automatically. New installations poll after 45 seconds without live notifications and run a full scan every five minutes. WebSocket reconnects and failed HTTP polls use exponential backoff capped at five minutes. Existing faster settings remain faster after upgrade.

New installations use a 64 MiB mobile-safe whole-file limit. An upgrade keeps a previously higher limit so an existing remote revision cannot strand the device.

Obsidian plugins do not run continuously in the iOS background. Meridian syncs when Obsidian opens or resumes. HTTP polling remains authoritative.

## Invariants and versions

- Vault plaintext is written only through `VaultPort`.
- Exact prepared retry bytes can stay in IndexedDB until commit.
- Every external JSON, binary, file-system, and cryptographic boundary validates input.
- HTTP signing bytes have one implementation in `packages/protocol`.

| Storage | Version |
| --- | ---: |
| Durable Object schema marker | **10** |
| IndexedDB | **6** |
