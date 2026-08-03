# Architecture

Meridian keeps protocol semantics independent from Cloudflare and Obsidian adapters.

```text
packages/protocol
   ↑          ↑
packages/crypto   packages/sync-engine
   ↑          ↑
   ├─ worker  └─ obsidian-plugin
   └─ obsidian-plugin

Worker → one Vault Durable Object → SQLite metadata
       └───────────────────────→ private R2 ciphertext
```

## Shared packages

- `packages/protocol` owns canonical wire formats, branded identifiers, signed HTTP request framing, log rules, and downgrade policy.
- `packages/crypto` owns standard-primitive composition, key lifecycle, certificates, pairing, recovery, and encrypted revisions.
- `packages/sync-engine` is the simulator reference model and owns the deterministic text merge also used by production.
- `packages/test-simulator` exercises convergence and no-silent-loss invariants independently from either runtime.

Dependencies point toward these packages. They never import Worker, Cloudflare, Obsidian, or browser UI code.

## Worker

`worker/src/index.ts` is the Hono composition root. Modules under `worker/src/http/` own public routes, bounded Effect Schema decoding, HTTP responses, setup-token checks, R2 streaming, and WebSocket upgrades. Normal vault calls cross one typed Durable Object RPC boundary. The only internal `fetch()` call is the WebSocket upgrade because it requires `Request` and `Response` upgrade semantics.

`VaultDurableObject` remains the single coordination boundary for a deployment. Its RPC methods receive decoded values and explicit session tokens, then return serializable success or error envelopes. SQL authentication and revocation checks remain authoritative inside the object. Its modules are split by domain:

- `vault/setup.ts`, `sessions.ts`, and `recovery.ts`: identity lifecycle;
- `vault/pairing.ts`: device registry and pairing;
- `vault/operations.ts`: ordered idempotent log and revocation;
- `vault/records.ts`: checkpoints and snapshots;
- `vault/notifications.ts`: hibernating WebSockets;
- `vault/migrations.ts`: ordered SQLite schema migrations;
- `vault/signing.ts`: Worker adapters around shared protocol signing bytes.

The Durable Object owns authoritative transactions. Extracted modules receive decoded domain values plus explicit SQLite and transaction capabilities; they do not parse HTTP, introduce independent state, or add locks. Hono converts RPC results back to the existing public status codes and JSON error contract.

## Obsidian plugin

`src/main.ts` is the Obsidian composition root. `src/plugin/` owns settings, protocol handlers, secret naming, vault events, resume behavior, and scheduling.

The sync path is divided into explicit services:

```text
SyncController
  ├─ Reconciler
  ├─ PullEngine → OperationApplier → RevisionLoader
  ├─ PushEngine
  └─ HistoryService → RevisionLoader
```

- `src/crypto/` owns device, pairing, revision, and Worker wire workflows. A stateless typed object supplies `CryptoPort` at the composition root.
- `src/network/` separates the portable client, response parsing, one-shot WebSocket connections, transport contract, and Obsidian transport. The plugin scheduler owns reconnect timing.
- `src/storage/` separates contracts, IndexedDB, memory tests, migrations, and IDB helpers.
- `src/ui/` separates status, settings, connection/recovery, history/conflicts, and device/pairing views.

Consumers import these owning modules directly. State-free compatibility barrels are not part of the runtime architecture.

### Crash-safe epoch changes

The Durable Object commits an epoch transition, authoritative epoch ID/sequence, recovery-package CAS, and pairing fence in one SQLite transaction. The signed transition carries one HPKE key package for each active device.

On pull, SecretStorage is the authoritative key state and IndexedDB is the recoverable log cursor:

```text
verify transition -> decrypt recipient key -> replace complete device secret
                  -> invalidate old prepared ciphertext -> advance IndexedDB cursor
```

A crash before secret replacement leaves the old cursor and replays the transition. A crash after secret replacement but before cursor advancement replays idempotently with the successor keyring. The cursor never passes a transition unless the successor secret is readable. Prepared revision plaintext is retained for successor-epoch re-encryption.

### Coordinated retention and upload integrity

Committed user history has infinite retention. Signed device acknowledgements report the exact durable cursor/hash and current epoch for every active device, but are telemetry only. The client persists the last accepted acknowledgement identity and signs again only after the checkpoint or epoch changes. Acknowledgements cannot authorize truncation without an authenticated generation-aware archive and rebootstrap path.

```text
upload request -> DO upload claim -> immutable R2 PUT -> DO confirmation
                                                     |
file operation commit <--- requires every blob ------┘
```

The Durable Object reconciles an R2 blob catalog when storage is inspected. Upload and provisional commit claims protect in-flight blobs from orphan cleanup. Cleanup installs a SQL deletion fence before deleting from R2, while commits reserve each blob before awaiting R2. These fences allow unrelated requests and WebSockets to continue while R2 deletion is pending. A revision cannot commit until every referenced blob is confirmed in R2 and its claim is rechecked in the operation transaction. If execution stops after R2 deletion but before SQL cleanup, the next upload confirms that the object is absent and atomically converts the stranded fence into a new upload claim. Attachment uploads and downloads use at most four concurrent chunk transfers. A started revision upload still reaches its commit boundary before pause.

IndexedDB compaction deletes only completed upload entries and history rows that exactly duplicate retained revision rows. It works in independent transactions of at most 500 deletions. Pending/prepared operations, dirty event tokens, DAG ancestry, conflicts, checkpoints, revocations, and file history remain untouched. Revision stores have `fileId` indexes, and the legacy stable-ID migration records an atomic completion marker instead of rescanning every startup. The journal hydrates one immutable in-memory snapshot index when it opens and updates it only after successful IndexedDB transactions, avoiding repeated `files.getAll()` deserialization. A pushed revision, its snapshot changes, and its completed journal entry commit in one transaction. A pulled revision, its snapshot and conflict changes, and affected entries also commit together. Checkpoint advancement remains a later transaction. Pull replay repairs matching prepared state before advancing the checkpoint, so older interrupted writes also recover safely. An outgoing entry whose server receipt was lost may remain pending past that checkpoint, then finish through an exact idempotent retry. If a later pulled revision directly descends from it, Meridian first completes the already-committed pending entry instead of reporting a false conflict.

### Responsive local indexing

Obsidian create, modify, delete, and rename events are coalesced by normalized path in the IndexedDB `dirty-paths` store before synchronization starts. Routine file-event and notification syncs scan only those paths. Journal entries, file snapshots, and consumed event tokens commit in one IndexedDB transaction; an event replaced during reconciliation therefore remains queued for the next pass.

Startup, resume, manual sync, settings changes, repair, and the periodic interval retain a complete vault scan. These scans recover events missed during suspension, crashes, direct filesystem changes, and plugin downtime. Local exclusions remain device-local during both scan modes.

```text
Obsidian events -> durable dirty paths -> targeted hash ---┐
       periodic/startup metadata inventory -----------------┤
       daily complete fingerprint audit --------------------┤
                                                            v
editor: Vault API reads/writes + final CAS      Worker: transferred-buffer hash
cooperative main-thread planner: collision, removal, and rename index
```

Periodic and startup reconciliation reuse stored fingerprints when path, size, modification time, and file kind match. New or metadata-changed files are read and hashed. When the complete path and fingerprint index is unchanged, reconciliation bypasses rename and collision planning after a linear collision check. A daily complete fingerprint audit detects same-size changes with preserved timestamps. The browser Worker receives required file buffers as transferables and performs SHA-256 fingerprinting away from the renderer. It never calls Obsidian APIs. Collision, removal, and rename planning use one implementation with bounded event-loop yields on every platform. Platforms that reject Blob Workers hash on the main thread. Pause and unload terminate pending Worker work; token-safe dirty records remain recoverable. Local index repair runs through the same maintenance owner as synchronization, so it cannot clear the live snapshot index during reconciliation.

One exact deadline timer replaces periodic scheduler ticks. Short edit bursts wait 1.5 seconds, rapid events coalesce for up to five seconds, and a pending batch gets a best-effort flush when the app becomes hidden. HTTP polling remains authoritative. WebSocket reconnects use jittered exponential backoff, and failed HTTP polls use exponential backoff; both cap at five minutes and resume immediately after the browser reports that it is online.

## Invariants

- Durable Object SQLite is the only ordered metadata authority.
- R2 stores immutable encrypted chunks only.
- WebSockets provide hints; authenticated HTTP pull remains authoritative.
- The plugin writes vault plaintext only through `VaultPort`; exact prepared retry bytes may remain in IndexedDB until their operation commits.
- Every external JSON, binary, filesystem, and cryptographic boundary validates its input.
- HTTP signing bytes have one implementation in `packages/protocol` to prevent client/server drift.
