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
- `packages/sync-engine` owns revision graphs, deterministic merge, conflicts, and crash-safe apply plans.
- `packages/test-simulator` exercises convergence and no-silent-loss invariants independently from either runtime.

Dependencies point toward these packages. They never import Worker, Cloudflare, Obsidian, or browser UI code.

## Worker

`worker/src/index.ts` is the Hono composition root. Modules under `worker/src/http/` own boundary decoding, Durable Object proxying, R2 streaming, setup routes, and WebSocket upgrades.

`VaultDurableObject` remains the single coordination boundary for a deployment. Its modules are split by domain:

- `vault/setup.ts`, `sessions.ts`, and `recovery.ts`: identity lifecycle;
- `vault/pairing.ts`: device registry and pairing;
- `vault/operations.ts`: ordered idempotent log and revocation;
- `vault/records.ts`: checkpoints and snapshots;
- `vault/notifications.ts`: hibernating WebSockets;
- `vault/migrations.ts`: ordered SQLite schema migrations;
- `vault/signing.ts`: Worker adapters around shared protocol signing bytes.

The Durable Object owns authoritative transactions. Extracted modules receive explicit SQLite and transaction capabilities; they do not introduce independent state or locks.

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

- `src/crypto/` adapts device, pairing, revision, and Worker wire workflows to `CryptoPort`.
- `src/network/` separates the portable client, response parsing, WebSocket reconnects, transport contract, and Obsidian transport.
- `src/storage/` separates contracts, IndexedDB, memory tests, migrations, and IDB helpers.
- `src/ui/` separates status, settings, connection/recovery, history/conflicts, and device/pairing views.

Compatibility barrels preserve stable imports while implementations remain replaceable and independently testable.

## Invariants

- Durable Object SQLite is the only ordered metadata authority.
- R2 stores immutable encrypted chunks only.
- WebSockets provide hints; authenticated HTTP pull remains authoritative.
- The plugin writes plaintext only through `VaultPort` and persists no plaintext in its journal.
- Every external JSON, binary, filesystem, and cryptographic boundary validates its input.
- HTTP signing bytes have one implementation in `packages/protocol` to prevent client/server drift.
