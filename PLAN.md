# Meridian plan

Meridian is a single-user, self-hosted Obsidian synchronization system running on Cloudflare. It will synchronize one vault between macOS and iOS while remaining offline-first and end-to-end encrypted.

This document records the current product, architecture, security, and delivery decisions. The protocol and threat model will be specified in dedicated documents before implementation begins.

## Goals

- Synchronize Markdown and arbitrary binary files between Obsidian devices.
- Synchronize selected Obsidian vault configuration categories with per-device controls.
- Work on macOS and iOS using only mobile-compatible Obsidian and web APIs.
- Remain fully usable offline and converge after reconnecting.
- Provide end-to-end encryption: Cloudflare never receives vault keys or plaintext content.
- Preserve immutable file history and support restoration.
- Never silently discard concurrent user content.
- Provide fast foreground synchronization and near-real-time notifications.
- Be straightforward to deploy into a personal Cloudflare account.

## Initial non-goals

- Multiple users, organizations, sharing, or billing.
- Simultaneous collaborative editing.
- CRDT-based storage. A CRDT may later be added for live editing of an open note, but the revision history remains authoritative.
- D1, because there are no global account or cross-vault queries.
- Cap'n Web, because the API is small and persistent RPC state conflicts with Durable Object WebSocket hibernation.
- Presigned R2 URLs. Blob traffic initially passes through the authenticated Worker and its R2 binding.
- A full web dashboard. The initial web surface is only the bootstrap experience and basic health information.
- Community plugin installation/settings sync and multiple configuration profiles in the initial MVP; these follow the first public release.
- Running alongside Obsidian Sync, iCloud synchronization, or another vault synchronization plugin.

## System overview

```text
Obsidian plugin
    |
    |-- HTTPS control and blob API --> Cloudflare Worker
    |                                      |
    |-- WebSocket notifications ----------|
    |                                      v
    |                               Vault Durable Object
    |                               - device registry
    |                               - ordered operation log
    |                               - cursors and idempotency
    |                               - hibernating sockets
    |
    `-- encrypted chunks ----------> Worker ----------> private R2 bucket
```

### Cloudflare primitives

- **Worker:** Hono HTTP adapter, authentication, validation, setup UI, blob streaming, and request orchestration.
- **Durable Object:** one object for the vault. It owns device authorization, the ordered encrypted operation log, monotonic cursors, idempotency records, setup state, and notification sockets.
- **Durable Object SQLite:** authoritative per-vault metadata storage.
- **R2:** immutable encrypted file chunks and, later if needed, large encrypted snapshots.
- **Workers Static Assets:** the minimal `/setup` interface and any later operational UI.
- **Queues:** deferred until retention and garbage collection require them.
- **D1:** not used for the single-user version.

Each piece of information has one authoritative home. File bytes are not stored in Durable Object SQLite, and vault metadata is not duplicated into D1.

## Repository architecture

The project uses a Bun and TypeScript workspace while remaining compatible with the Deploy to Cloudflare button.

```text
meridian/
|-- .github/workflows/ci.yml
|-- .releaserc.json
|-- README.md
|-- LICENSE
|-- manifest.json               # required at root by Obsidian
|-- versions.json               # Obsidian compatibility map
|-- wrangler.jsonc              # root config required by deploy button
|-- package.json                # root build/deploy scripts
|-- bun.lock
|-- worker/
|   `-- src/
|-- obsidian-plugin/
|-- packages/
|   |-- protocol/
|   |-- crypto/
|   |-- sync-engine/
|   `-- test-simulator/
|-- docs/
|   |-- protocol.md
|   `-- threat-model.md
`-- PLAN.md
```

The Deploy to Cloudflare button targets the repository root. `wrangler.jsonc` points to the Worker entrypoint under `worker/`, allowing Wrangler to bundle shared workspace packages. The root Obsidian metadata coexists with the Cloudflare configuration. The Obsidian plugin has an independent build and semantic-release workflow.

## Technology stack

### Shared

- Bun workspaces
- TypeScript
- Versioned protocol types and codecs
- Vitest
- `fast-check` for state-machine and property tests

### Obsidian plugin

- Obsidian Plugin API
- `requestUrl()` for HTTP
- Browser WebSocket with polling fallback
- WebCrypto and audited mobile-compatible cryptographic dependencies
- IndexedDB for rebuildable sync state, checkpoints, and the local operation journal
- Obsidian `SecretStorage` for private device and vault keys
- Obsidian-native settings and views
- No Node.js, Electron, native addon, or direct filesystem dependency in portable code

### Worker

- Cloudflare Workers
- Hono as a thin HTTP and WebSocket adapter
- Effect v4 for typed errors, services, resource handling, and orchestration
- Effect Schema at every untrusted boundary
- Native Workers RPC for Worker-to-Durable-Object calls
- Raw Durable Object SQLite to preserve transactions and platform capabilities
- Workers Logs and Traces with privacy-safe fields only

## Plugin distribution and releases

Meridian follows the automated release pattern used by Fast Resume, adapted to Obsidian's release requirements.

### Distribution channels

- **Development:** build or copy `main.js`, `manifest.json`, and optional `styles.css` into a disposable vault's `.obsidian/plugins/meridian/` directory.
- **Beta:** publish GitHub Releases and let testers install and update through BRAT.
- **Stable:** submit the public GitHub repository to the official Obsidian Community Plugins directory. After approval, users install Meridian from Obsidian on macOS or iOS, and Obsidian retrieves updates from GitHub Releases.

Every GitHub Release contains these assets:

```text
main.js
manifest.json
styles.css       # optional
```

Generated `main.js` is a release artifact and is not committed to the repository.

### Release automation

Conventional commits and semantic-release own plugin versioning. A merge to the default branch triggers CI, which:

1. validates commits, formatting, types, tests, Worker bindings, and plugin builds;
2. determines whether the change requires a patch, minor, or major release;
3. updates `manifest.json`, `versions.json`, the plugin package version, and `CHANGELOG.md`;
4. builds and verifies the final plugin artifacts;
5. creates the release commit and Git tag;
6. publishes the GitHub Release with all required assets already attached.

Obsidian requires the Git tag to match the manifest version exactly, so semantic-release uses `tagFormat: "${version}"` rather than its default `v${version}`:

```text
manifest version: 0.1.0
Git tag:          0.1.0
```

Developers do not manually create release tags. The workflow must publish assets atomically with the release so Obsidian never observes a release before `main.js` and `manifest.json` are available. Worker deployment versions remain independent from Obsidian plugin releases.

## Bootstrap and setup

The Worker is deployed before the plugin is connected.

1. The user clicks **Deploy to Cloudflare**.
2. The deployment form asks the user to choose a high-entropy, one-time `SETUP_TOKEN` secret.
3. Cloudflare provisions the Worker, Durable Object namespace, R2 bucket, and bindings.
4. The user opens `https://<worker>/setup` and enters the same token.
5. The Worker verifies it and creates a short-lived, single-use setup session.
6. The page offers an **Open in Obsidian** deep link, QR code, and copyable fallback.
7. The plugin receives the endpoint and temporary setup session.
8. The plugin generates the first device keys, vault key, and recovery material locally.
9. The plugin sends only public keys and proof of possession to claim the deployment.
10. The Durable Object records that the vault is claimed and permanently rejects the setup token and setup sessions.
11. The plugin performs the initial encrypted upload.

The setup token is never included in the QR code, committed to the repository, or written to application/build logs. The stored secret may remain configured, but the Durable Object's claimed state makes it unusable.

## Authentication and key ownership

There is no username, account password, or passkey in the core sync system.

```text
Setup token   -> claims a new deployment once
Device key    -> authenticates one Mac or iPhone
Vault key     -> encrypts vault data
Recovery code -> restores ownership after losing all devices
```

### Device authentication

Each device generates its own signing and key-exchange keypairs. On startup or session expiry:

1. The plugin requests a random server challenge.
2. It signs the challenge with its device private key.
3. The Worker verifies the signature against the public device registry.
4. The Worker returns a short-lived session token.
5. HTTP requests and the notification WebSocket use that session.

Durable revision envelopes are additionally signed by their author device. Session authentication controls current API access; revision signatures preserve durable authorship and integrity.

### Adding a device

1. An authorized device selects **Add device**.
2. The server creates a short-lived, single-use pairing request.
3. The existing device displays a QR/deep link with the endpoint, vault ID, and pairing capability.
4. The new device generates its signing and key-exchange keys and submits the public keys.
5. Both devices derive and display a short authentication phrase from the complete pairing transcript.
6. The existing device explicitly approves the new device and signs its authorization certificate.
7. The current vault epoch key is transferred with HPKE RFC 9180 using DHKEM(X25519, HKDF-SHA-256), HKDF-SHA-256, and AES-256-GCM.
8. The existing device signs the complete pairing transcript so the HPKE transfer, device identity, certificate, vault, and epoch cannot be substituted independently.
9. The new device verifies the authorization chain, transcript signature, and authentication phrase before decrypting and beginning initial synchronization.

### Device authorization certificates

Every device has a signed, vault-scoped authorization certificate containing:

```text
vault ID
Device ID
Ed25519 signing public key
HPKE/X25519 public key
Permissions
Issuer certificate ID
Authorized key epoch and protocol suite
Optional expiry or validity constraints
```

The initial trust anchor is created from the recovery seed during first-device setup. Later device certificates must form a valid authorization chain from that anchor through an active owner-authorized device. Revocation is a separate signed, append-only log operation because an issued certificate is immutable. Operations are accepted only when their author was authorized for the relevant vault and epoch and the operation was committed before any effective revocation.

### Recovery and revocation

The first device generates a random 256-bit recovery seed, represented as a recovery code or word sequence and stored outside the vault. HKDF domain separation derives independent recovery signing and recovery encryption keys. The recovery public key anchors device authorization; the server stores only public recovery information and an authenticated encrypted recovery package.

The recovery package contains enough encrypted state to restore ownership and the current vault epoch. An optional user password may additionally wrap the high-entropy recovery material with versioned Argon2id parameters, but a password never replaces the recovery seed.

A recovery operation verifies a server challenge, unwraps the package locally, registers a replacement device, revokes lost devices, and creates a new signed key epoch. Revocation blocks future API access and future-epoch decryption, but cannot erase data already downloaded by a lost device.

## Cryptographic model

The detailed construction and exact libraries require a written threat model, deterministic protocol specification, test vectors, and cross-platform security tests. The baseline key hierarchy is:

```text
256-bit recovery seed
    |-- recovery signing key: offline trust anchor and recovery authorization
    `-- recovery encryption key: protects the server-stored recovery package

Owner-authorized device certificates
    `-- authorize device signing and HPKE keys

Vault epoch key
    `-- wraps random per-revision data-encryption keys

Random revision key
    `-- encrypts that revision's file chunks
```

Files are never encrypted directly with the recovery seed or another long-lived root key. A fresh random revision key limits accidental key/nonce reuse and makes future key rotation tractable.

The baseline primitives and rules are:

- HKDF-SHA-256 with explicit, versioned domain-separation labels;
- AES-256-GCM through WebCrypto for authenticated content and recovery-package encryption;
- AES-256-KW for wrapping each random revision key with a revision-specific KEK derived from the vault epoch key, vault ID, epoch ID, and revision ID;
- a fresh random nonce for every AES-GCM encryption under the same key, with duplicate detection across all chunks encrypted by one revision key;
- Ed25519 for device operations, certificates, pairing transcripts, checkpoints, and recovery authorization;
- HPKE RFC 9180 for vault epoch transfer between devices;
- Argon2id only when password-wrapping high-entropy recovery material;
- cryptographically random vault, device, operation, revision, epoch, and object identifiers;
- no custom elliptic-curve, AEAD, KDF, or password-hashing implementation.

Every encrypted object authenticates associated data that includes at least:

```text
protocol and cipher-suite version
vault and epoch ID
file and revision ID
operation type
chunk index and total count
```

This prevents a valid ciphertext from being moved between vaults, epochs, files, revisions, operations, or chunk positions.

Durable envelopes use deterministic CBOR with strict decoding. Signatures cover the exact canonical bytes. Decoders reject duplicate fields, unknown critical fields, non-canonical encodings, invalid lengths, and trailing data.

Every signed vault epoch declares its protocol generation, KEM, KDF, AEAD, key-wrapping algorithm, signature algorithm, and encoding. Devices persist the highest accepted generation and reject unauthorized downgrades. Algorithm migration creates a new owner-authorized epoch rather than changing an existing envelope's interpretation.

### Rollback and equivocation resistance

- The ordered operation log is hash-chained.
- Each device persists its highest trusted cursor and log hash before acknowledging progress.
- A device rejects a server state older than or inconsistent with its local checkpoint.
- Pairing transfers a signed trusted checkpoint to the new device.
- Devices periodically publish signed checkpoints that bind the vault, epoch, cursor, and log hash.

These controls detect ordinary rollback for existing and newly paired devices. They cannot fully detect a malicious server presenting isolated devices with separate valid histories. Cross-device checkpoint gossip or a transparency log remains future hardening.

Paths, timestamps, file types, revision relationships, tombstones, and manifests are encrypted. The server still observes deployment and device relationships, IP addresses, operation timing, ciphertext sizes, chunk counts, access patterns, and total storage.

Deterministic content encryption and plaintext content hashes are not used initially. This avoids equality leakage at the cost of cross-version deduplication.

## Revision and synchronization model

Meridian uses an immutable per-file revision DAG carried by an encrypted append-only vault log.

```text
Normal history:

A --> B --> C

Concurrent edits:

      /--> B (Mac)
A ---
      \--> C (iPhone)

Merged:

B --\
     >--> D
C --/
```

A revision identifies its parent revisions and references immutable encrypted content chunks. A merge revision references every resolved head. Deletes are tombstone revisions. Restoring an old version creates a new revision rather than rewriting history.

### Local change capture

The plugin combines:

- Obsidian file events for low latency;
- a durable local journal for crash recovery;
- startup and resume reconciliation;
- periodic full scans to recover missed or coalesced events;
- normalized paths, Unicode NFC handling, and case-fold collision detection.

Modification timestamps are hints only. Causality comes from revision parents and persisted cursors.

### Push

1. Capture a stable local file snapshot.
2. Split content into approximately 4-8 MiB chunks when necessary.
3. Encrypt and authenticate every chunk locally.
4. Upload missing immutable ciphertext chunks through the Worker into R2.
5. Submit a signed, encrypted, idempotent operation to the Durable Object.
6. Atomically append the operation and assign the next cursor.
7. Notify connected devices that the latest cursor advanced.

Blobs are uploaded before their referencing operation. A failed commit may leave an unreferenced encrypted blob, which later garbage collection can safely remove.

### Pull and apply

1. Request operations after the last safely applied cursor and trusted log hash.
2. Verify hash-chain continuity, signed checkpoints, author authorization, signature, protocol suite, canonical envelope, and downgrade policy.
3. Download referenced ciphertext chunks through the Worker.
4. Authenticate and decrypt locally.
5. Compare against uncommitted local changes before replacing anything.
6. Apply through a crash-safe local journal and temporary path where supported.
7. Persist the new cursor only after successful application.

Duplicate requests and replayed operations are harmless because operations have stable idempotency identifiers.

## Conflict rules

- Non-overlapping UTF-8 text edits use a deterministic three-way merge.
- Overlapping text edits create deterministic conflict files unless the user resolves them.
- Binary conflicts preserve every branch as separate files.
- Rename plus content edit may merge if the file identity and ancestry are unambiguous.
- Concurrent rename conflicts preserve a deterministic canonical path and expose alternatives.
- Concurrent delete/edit removes the original path but materializes the edit as a recovered conflict.
- User resolution creates a new revision referencing every resolved head.
- Concurrent content is never silently discarded.

## R2 blob storage

The R2 bucket remains private. Object names contain only opaque vault and ciphertext identifiers:

```text
vaults/<opaque-vault-id>/blobs/<opaque-blob-id>
```

The Worker exposes authenticated streaming endpoints such as:

```text
PUT /v1/blobs/:blobId
GET /v1/blobs/:blobId
```

The Worker never decrypts blob bodies. Initial 4-8 MiB chunks stay comfortably below normal Worker request limits and make retries resumable. Presigned URLs are deferred because they require separately managed R2 S3 credentials and complicate one-click deployment.

Older revision blobs remain available for version history until an explicit retention policy makes them eligible for garbage collection.

## Notification WebSocket

The WebSocket is a latency optimization, not a delivery mechanism. Messages are self-contained hints:

```json
{
  "type": "cursor-advanced",
  "cursor": 127
}
```

The client always pulls durable operations after its persisted cursor. Notifications may be lost, delayed, duplicated, or coalesced without affecting correctness.

The Durable Object uses the WebSocket Hibernation API. Only a small serialized attachment, such as device and vault identifiers, must survive hibernation. No callbacks, remote object references, or important in-memory subscription state are required.

On every connection, reconnection, and application resume, the server sends its current cursor so races around subscription establishment cannot hide an operation.

## iOS constraints

Meridian can synchronize reliably while Obsidian is open. A community plugin cannot add native background-transfer or push capabilities to the Obsidian iOS application. iOS may suspend the process and reclaim its socket.

Therefore:

- WebSockets are never required for correctness.
- The plugin reconnects and reconciles immediately on resume.
- Every transfer and application step is resumable.
- Local state is persisted before yielding control.
- Binary APIs and memory behavior are tested on real iPhones.
- A practical initial attachment-size limit may be necessary because Obsidian exposes whole-file `ArrayBuffer` operations rather than a documented streaming filesystem API.

## Vault configuration sync

Meridian mirrors Obsidian Sync's category-based model rather than blindly synchronizing the entire configuration directory. Every device configures its own sync choices. The choices themselves are device-local and are not synchronized.

The first public release supports these independently selectable categories:

```text
Main settings              default on
Appearance                 default on
Themes and CSS snippets    default on
Hotkeys                    default on
Active core plugin list    default on
Core plugin settings       default on
```

Later releases add opt-in community plugin installation/list synchronization and multiple configuration profiles such as separate desktop and mobile configurations.

Implementation rules:

- Resolve the active configuration directory through `vault.configDir`; never hardcode `.obsidian`.
- Maintain a versioned allowlist that maps supported Obsidian configuration files to user-facing categories.
- Use the adapter and periodic hashing because ordinary Vault APIs and events do not cover hidden configuration files reliably.
- Encrypt, version, and restore configuration revisions through the same revision DAG as vault content.
- Keep configuration sync selections per-device, matching Obsidian Sync.
- Hot-reload only settings covered by supported Obsidian APIs; otherwise finish the transfer and ask the user to restart or reload Obsidian.
- Keep conflicting configuration revisions out of the active configuration directory until Meridian can deterministically merge them or the user chooses one.
- Always exclude workspace/layout state, caches, temporary files, Meridian's own journal and device identity, and any local secret storage.
- Do not sync arbitrary community plugin `data.json` files without an explicit future per-plugin policy because they may contain credentials, machine paths, or caches.

## HTTP surface

The precise wire protocol will be specified separately. The expected coarse endpoints are:

```text
GET  /health
GET  /setup
POST /v1/setup/session
POST /v1/setup/claim
POST /v1/auth/challenge
POST /v1/auth/session
POST /v1/pairings
POST /v1/pairings/:id/approve
GET  /v1/changes?after=<cursor>
POST /v1/operations
GET  /v1/snapshot
PUT  /v1/blobs/:blobId
GET  /v1/blobs/:blobId
GET  /v1/notifications        # WebSocket upgrade
```

Mutations require exact schema validation, authenticated device context, bounded bodies, rate limits where appropriate, and idempotency identifiers. The sync API uses application authentication rather than Cloudflare Access. A future administrative web surface may use Access separately.

## Version history and retention

- Revisions, merges, and tombstones are immutable.
- Restoring creates a new revision referencing old content.
- The plugin provides history, diff, restore, and conflict views.
- Retention is initially conservative; data is not automatically deleted until the protocol has safe acknowledgement and recovery semantics.
- Pinned revisions are never collected.
- Later garbage collection must tolerate retries, partially failed R2 deletes, and devices that were offline for long periods.
- Synchronization is not a backup. Export and independent backup guidance are required before production use.

## Observability and operations

Record privacy-safe operational signals only:

- request and operation result classes;
- durations and binding latency;
- encrypted byte and chunk counts;
- cursor lag;
- reconnects, retries, and reconciliation outcomes;
- authentication, pairing, and revocation events without credentials;
- storage and garbage-collection metrics.

Never record setup tokens, session tokens, private keys, recovery material, plaintext paths, content, encrypted envelope bodies, or stable identifiers that are unnecessary for diagnosis.

## Testing strategy

The sync engine must be proven in simulation before touching an important vault.

### Protocol and state-machine tests

- deterministic convergence from the same operation set;
- concurrent edits, renames, moves, deletes, and restores;
- duplicate, delayed, dropped, and reordered network actions;
- stale cursors and stale device snapshots;
- interrupted upload, commit, download, and local apply;
- process crashes at every persistence boundary;
- wrong clocks and timestamp changes;
- case-sensitive versus case-insensitive path collisions;
- Unicode normalization collisions;
- large binary and high-file-count scenarios;
- device revocation and key-epoch transitions.

### Security tests

- cryptographic known-answer vectors, including the selected RFC 9180 HPKE suite;
- deterministic CBOR cross-implementation vectors and rejection of non-canonical, duplicate, unknown-critical, or trailing fields;
- envelope tampering and Ed25519 signature rejection;
- associated-data substitution across vaults, epochs, files, revisions, operation types, and chunk positions;
- nonce uniqueness enforcement and duplicate-nonce rejection across every chunk sharing a revision key;
- invalid, expired, cyclic, unauthorized, and revoked device certificate chains;
- pairing transcript substitution and authentication-phrase mismatch;
- recovery with wrong seeds, wrong passwords, stale packages, and rotated epochs;
- log truncation, rollback below a persisted checkpoint, hash-chain forks, and stale pairing checkpoints;
- replay and idempotency behavior;
- expired setup, session, upload, and pairing capabilities;
- unauthorized blob access;
- protocol suite migration and downgrade rejection.

### Platform tests

- Workers Vitest integration for Worker, Durable Object, and R2 bindings;
- Obsidian adapter fakes for deterministic unit tests;
- actual macOS and iOS vault tests;
- suspend/resume and network transition tests on iOS;
- setup deep-link and QR fallback validation.

## Delivery phases

### Phase 0: specifications

- Write the threat model.
- Specify the key hierarchy, domain-separation labels, nonce rules, associated data, and signed cipher suites.
- Specify deterministic CBOR operation envelopes and strict decoding rules.
- Specify HPKE pairing transcripts, authentication phrases, device authorization chains, recovery, revocation, and epoch rotation.
- Specify the hash-chained log, persistent high-water marks, signed checkpoints, and documented equivocation limits.
- Define filesystem normalization and deterministic conflict behavior.
- Publish protocol and cryptographic test vectors before implementing production storage.

### Phase 1: deterministic simulator

- Build an in-memory server and multiple simulated devices.
- Model offline work, arbitrary delivery order, duplication, crashes, and restoration.
- Model malicious rollback, log truncation, invalid authorization chains, stale checkpoints, replay, and downgrade attempts.
- Prove convergence, no-silent-loss, authorization, and rollback-detection invariants with property tests.

### Phase 2: Cloudflare storage core

- Establish the root-deployable workspace and Wrangler configuration.
- Implement Durable Object migrations, encrypted operation append, cursor reads, and idempotency.
- Implement authenticated R2 proxy endpoints.
- Add Workers integration tests and privacy-safe observability.

### Phase 3: desktop plugin

- Implement local journal, scanning, hashing, encryption, upload, pull, and safe application.
- Support text and binary files.
- Implement conflict materialization and version restoration.
- Add conventional-commit validation, semantic-release configuration, and atomic GitHub Release artifact publication.
- Validate local installation and BRAT updates against disposable macOS vaults.

### Phase 4: setup, device lifecycle, and configuration sync

- Add the Deploy to Cloudflare configuration and minimal `/setup` UI.
- Implement bootstrap claim and challenge-response sessions.
- Implement RFC 9180 HPKE pairing, transcript signatures, authentication phrases, device certificate chains, recovery, revocation, and signed epoch rotation.
- Implement persistent rollback checkpoints and checkpoint transfer during pairing.
- Add status and device-management views inside Obsidian.
- Implement per-device configuration-sync categories for main settings, appearance, themes/snippets, hotkeys, and core plugins.
- Add restart/reload guidance and safe configuration-conflict handling.

### Phase 5: iOS hardening

- Remove or replace any accidental desktop-only dependency.
- Test memory limits, large attachments, interruption, resume, and network switching.
- Tune scan and transfer concurrency for battery and responsiveness.

### Phase 6: live notifications and operations

- Add hibernating WebSocket cursor notifications.
- Add periodic polling fallback and reconnect behavior.
- Add health, repair, integrity audit, export, and operational documentation.

### Phase 7: retention, stable distribution, and optional UI

- Design acknowledgement-aware retention and idempotent R2 garbage collection.
- Add pinned revisions, quotas, and bulk-deletion protection.
- Complete Obsidian policy, submission, and public-repository requirements.
- Submit a tested release to the Obsidian Community Plugins directory.
- Consider a web operational dashboard only if the plugin UI is insufficient.
- Consider direct presigned R2 transfers only if measurements prove the Worker proxy is a bottleneck.

### Phase 8: post-release configuration parity

- Add opt-in active and installed community plugin list synchronization.
- Define an explicit policy for community plugin settings and secret-bearing `data.json` files.
- Add multiple configuration profiles for separate desktop and mobile setups.

## MVP completion criteria

The MVP is complete only when:

- macOS and iOS converge after arbitrary offline edits;
- text, images, and representative binary attachments synchronize;
- selected main, appearance, hotkey, theme/snippet, and core-plugin settings synchronize safely;
- configuration choices remain device-local and excluded configuration state does not leak across devices;
- Cloudflare cannot decrypt content or filenames;
- concurrent content is merged or preserved as an explicit conflict;
- interrupted operations resume without corrupting the local vault;
- history can restore files after edit and deletion;
- a second device pairs through authenticated HPKE and receives a valid vault-scoped certificate;
- a lost device can be revoked and excluded from the next signed key epoch;
- recovery succeeds from the documented recovery material without exposing plaintext keys to the server;
- existing and newly paired devices reject log rollback below their trusted checkpoints;
- canonical encoding, associated-data binding, certificate validation, crypto migration, and downgrade tests pass on supported platforms;
- WebSocket loss does not prevent eventual synchronization;
- plugin releases install and update from GitHub on macOS and iOS, with tags matching manifest versions;
- deploy, setup, upgrade, backup, repair, and rollback procedures are documented;
- the system has passed extended testing on disposable vaults and is clearly marked unsafe as the sole copy until production hardening is complete.

## Key risks

- Filesystem reconciliation and cross-platform rename semantics are harder than transport.
- Any malicious Obsidian plugin can potentially access plaintext content and locally available secrets.
- A malicious server can withhold operations or isolate devices on separate histories; persistent checkpoints detect rollback, while full equivocation detection requires future checkpoint gossip or transparency infrastructure.
- Recovery after losing every device cannot detect server rollback newer than the last independently retained recovery checkpoint.
- A compromised release workflow or malicious plugin update can steal locally available keys, so supply-chain hardening is part of the security boundary.
- Safe garbage collection conflicts with devices that remain offline indefinitely.
- Key revocation cannot remove historical data already obtained by a device.
- Version history can amplify accidental mass changes or storage use.
- Whole-file mobile APIs may constrain very large attachments.
- Sync must not be marketed or treated as a backup.

## Immediate next action

Create `docs/threat-model.md` and `docs/protocol.md`, then implement the deterministic simulator. No production Worker or real-vault mutation should be built before the core invariants and wire protocol are explicit and testable.
