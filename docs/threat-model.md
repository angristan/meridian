# Meridian threat model

Status: draft for protocol generation 1. Meridian is a sync system, not the only backup of a vault.

## Scope

Meridian synchronizes one user's Obsidian vault through a self-hosted Cloudflare Worker, one vault Durable Object, and a private R2 bucket. The supported clients are a macOS Obsidian plugin and the foreground iOS plugin. This model covers protocol, storage, network, device lifecycle, recovery, and update risks. It does not claim protection from a compromised endpoint while that endpoint can read the vault.

## Assets

Highest-value secrets:

- plaintext notes, paths, attachments, and selected Obsidian configuration;
- recovery seed and derived recovery private keys;
- current and historical vault epoch keys;
- device Ed25519 and X25519 private keys;
- random per-revision content keys;
- setup, pairing, session, and upload capabilities while valid.

Integrity assets:

- file revision DAGs and conflict branches;
- device authorization and revocation history;
- epoch/generation history;
- ordered log cursor/hash and signed checkpoints;
- release artifacts and plugin update metadata;
- local journal state used for crash-safe application.

Availability assets include the Worker, Durable Object, R2 ciphertext, local vault copies, recovery material, and independent backups.

## Trust boundaries

```text
plaintext + long-lived private keys
            |
            v
  Obsidian process / plugin  -- authenticated TLS -->  Cloudflare edge
            |                                      Worker / Durable Object / R2
            v                                                  |
 SecretStorage + local journal                                 v
                                               ciphertext + public auth data
```

Trusted for confidentiality and correct local behavior:

- the user's device OS, Obsidian application, installed plugins, and Meridian bundle at execution time;
- WebCrypto and the pinned audited cryptographic dependencies;
- device secret storage and the user's handling of recovery material;
- the local journal/checkpoint implementation;
- the build and release process that produced the installed plugin.

Not trusted with plaintext or vault keys:

- Cloudflare, Worker operators, Durable Object and R2 storage;
- networks, DNS resolvers, and notification delivery;
- other devices until their complete authorization chain and pairing transcript verify.

The server is relied on for availability and a convenient ordering service, but clients verify its cryptographic output.

## Adversaries

The design considers:

1. A passive network observer measuring connections, timing, and sizes.
2. An active network attacker who can replay, delay, reorder, truncate, or substitute traffic but cannot break correctly validated TLS and cryptography.
3. A compromised or malicious Cloudflare deployment that can read/modify all server state, isolate clients, withhold operations, and lie about cursors.
4. An unauthorized person who learns a setup/session/pairing token, but not device or recovery keys.
5. A lost or stolen device, before and after revocation.
6. A malicious vault file, attachment, or remote ciphertext intended to exploit parsing and resource handling.
7. A compromised dependency, CI workflow, GitHub release, Obsidian update, or malicious plugin update.
8. Another Obsidian plugin running with the same effective access to vault plaintext and plugin APIs.
9. Accidental corruption, crashes, partial uploads, incorrect clocks, path collisions, and user mistakes.

Out of scope as preventable attacks:

- a fully compromised authorized endpoint while it holds plaintext and keys;
- cryptanalysis of the selected standard primitives;
- coercion or physical observation of the recovery code or pairing phrase;
- traffic-analysis resistance, cover traffic, or storage-size hiding;
- guaranteed service despite account deletion, Cloudflare outage, or deliberate data destruction.

## Security goals

### Confidentiality

The server must not learn plaintext file content, paths, revision parents, tombstones, content types, selected configuration content, epoch keys, revision keys, device private keys, or recovery material. A network attacker must gain no more through application traffic than the server can observe.

A revoked device must not receive keys for future epochs. Rotation does not erase old plaintext, ciphertext, or keys already obtained by that device.

### Integrity and authenticity

Clients accept an operation only when canonical encoding, suite policy, hash-chain continuity, device authorization at the assigned cursor, durable signature, key unwrap, AEAD tags, chunk positions, and plaintext lengths all verify. Recovery, certificates, epochs, pairing transfers, and checkpoints have separate signature domains.

No concurrent revision is silently discarded. Conflict materialization and restoration append history rather than rewriting it.

### Rollback and downgrade detection

A device with a retained high-water mark detects a lower cursor, a conflicting hash at the same cursor, hash-chain truncation/forking after its checkpoint, an older epoch sequence, and an unauthorized lower protocol generation. A newly paired device inherits a signed checkpoint inside the complete pairing transcript.

### Availability and recoverability

Local vault use remains available offline. Push/pull is idempotent and resumable. Uploading immutable blobs before committing an operation makes a partial push non-authoritative. Local application is journaled and a cursor advances only after successful apply. High-entropy recovery material can restore ownership if all devices are lost, subject to the rollback limitation below.

## Mitigations by threat

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Server reads R2/DO | Client E2EE; private R2; random keys and opaque IDs | sizes, timing, device/deployment relation, stable opaque access patterns |
| Ciphertext moved across context | Canonical AEAD data binds suite, vault, epoch, file, revision, object kind, operation, and position | none assuming AEAD security and correct inputs |
| Operation tampering | Strict CBOR, Ed25519 domain signatures, hash chain | server can withhold a valid operation |
| Nonce reuse | fresh revision keys, random 96-bit nonces, per-revision duplicate registry | faulty RNG can still be catastrophic; platform RNG is trusted |
| Replay/duplicate requests | stable operation/idempotency IDs and append transaction | resource exhaustion still needs server rate limits |
| Stolen session | short expiry, exact authorization checks | bearer can act until expiry, bounded by certificate permissions |
| Pairing MITM/substitution | signed device descriptor, ciphertext-free verification preview, two explicit phrase confirmations, owner-local HPKE transfer withholding, full signed transcript, certificate chain, 40-bit phrase, short expiry | user can confirm a mismatched phrase or attacker can guess at 1 in 2^40 per attempt |
| Lost device | revoke certificate, reject later operations/sessions, recipient-exact automatic epoch rotation | downloaded history and old keys cannot be erased |
| Malicious or stale recovery package | legacy AES-GCM or owner-signed HPKE package, vault-bound context, required transition ID, public state ID, predecessor CAS | a malicious server can still roll back its complete stored state; an independent checkpoint is needed to detect all-device-loss rollback |
| Server rollback | persisted cursor/hash/generation, signed transferred checkpoints | isolated split views are not fully detectable |
| Downgrade | complete suite in signed epoch; durable highest generation/sequence | a compromised endpoint can alter its own local floor |
| Parser bombs | closed schemas, strict canonical subset, bounded bytes/depth/collections/chunks | host memory pressure still requires platform testing |
| Partial write/crash | immutable blobs/revisions, server transaction, local journal, apply-before-cursor | abandoned ciphertext requires later conservative GC |
| Wrong clock | causality from parents/cursors; timestamps are hints | expiry checks need reasonable local/server time policy |
| Path collision | NFC, relative paths, case-fold collision detection, deterministic conflict names | platform-specific reserved names need adapter tests |
| Malicious notification | notification is a hint; HTTP pull is authoritative | reconnect storms require backoff/rate limits |
| Setup-token leak | high entropy, never in QR/logs, short setup session, permanent claimed state | leak before legitimate claim can race setup |
| Other Obsidian plugin | no protocol mitigation | plugin can read plaintext and may access in-process secrets |
| Compromised release | pinned dependencies, reproducible reviewable build, CI validation, signed repository controls | malicious trusted update can exfiltrate all local secrets |

## Malicious server analysis

The server can:

- refuse service, delete ciphertext, return stale availability data, or delay a device indefinitely;
- observe IP addresses, user agent/platform hints, request timing, ciphertext sizes, chunk counts, total storage, cursor lag, and which opaque blobs are accessed;
- identify devices and their public authorization relationships;
- present one device with a valid prefix while another sees a later prefix;
- attempt separate valid-looking histories by isolating devices before they exchange checkpoints.

The server cannot forge recovery/device signatures, authenticate modified ciphertext, unwrap revision keys, or move a valid object into another authenticated context without detection.

Persistent checkpoints detect ordinary rollback relative to prior knowledge. They do **not** provide global consistency. Two devices that never compare checkpoints can be kept on separate valid forks after a malicious ordering service equivocates. Future hardening may add checkpoint gossip or an external transparency log. Until then, users should compare device status/checkpoints when integrity is in doubt.

## Endpoint compromise

Obsidian must see plaintext to edit it. Meridian must see plaintext and keys to synchronize it. Malware, a malicious Obsidian plugin, debugger access, a compromised OS, or a malicious Meridian release can therefore read or change all locally available data and impersonate that device.

SecretStorage improves at-rest handling but is not a hardware-backed isolation boundary from code running in Obsidian. The design limits damage after detection by certificate revocation and epoch rotation; it cannot recover confidentiality for content already read. An operator should remove the compromised device, rotate the epoch from a trusted device or recovery flow, and inspect history for signed malicious revisions.

## Recovery limitations

The recovery seed is a random 256-bit root capability. It must be stored outside the synchronized vault and preferably in more than one physically separate secure location. A screenshot, plaintext note in the vault, low-entropy replacement, or cloud clipboard defeats the model.

The server-stored package is authenticated but can be old. Recovery predecessor CAS prevents a client holding a stale package from replacing a newer package. It cannot stop a malicious server from rolling back the package, its public state ID, and history together. If one trusted device survives, its persisted checkpoint detects this rollback. If every device and every independent checkpoint is lost, the recovery seed proves ownership and decrypts the package but cannot reveal whether the server withheld a newer valid package/history. The recovered user must treat the server's checkpoint as the newest available, not cryptographic proof that no later state existed.

A password may only add Argon2id wrapping around high-entropy recovery material. Password-only recovery is excluded because an attacker with the server package could perform offline guessing.

## iOS and offline behavior

The iOS plugin has no reliable background execution. Suspension can interrupt any request and discard a socket. Correctness therefore depends only on durable HTTP state, local journaling, and resume reconciliation. WebSocket loss, duplicate hints, and long offline periods must not lose data.

Whole-file Obsidian APIs can cause memory pressure for large attachments. Generation 1 chunks network ciphertext at 4–8 MiB, but snapshot capture may still hold the source file in memory. The plugin should impose a documented tested attachment limit, bound concurrency, and never mark a cursor applied after an out-of-memory or interrupted write.

## Operational assumptions

- TLS certificate validation remains enabled. Application cryptography does not justify bypassing TLS.
- Setup, session, pairing, and upload capabilities are random, scoped, logged only by result class, rate-limited, short-lived, and single-use where applicable.
- Logs/traces never include tokens, stable unnecessary IDs, envelope bodies, plaintext, paths, keys, recovery codes, or pairing plaintext.
- R2 is private and only authenticated Worker routes access it.
- Garbage collection is disabled until acknowledgement and offline-device safety are specified. Pinned/history data is retained conservatively.
- Sync is not backup. Users keep independent versioned backups and test export/restore.
- Real macOS and iOS tests cover suspend/resume, large files, Unicode/case collisions, and interrupted apply before production use.

## Security validation

Required automated coverage includes:

- published HKDF, Ed25519, AES-GCM, AES-KW, HPKE, and canonical-CBOR vectors;
- non-canonical, duplicate, unknown-field, trailing, malformed-length, and resource-limit rejection;
- signature, tag, wrapped-key, AAD-context, phrase, transcript, and proof-of-possession tampering;
- expired, cyclic, cross-vault, unauthorized, and revoked certificate chains;
- stale epochs, suite downgrade, cursor rollback, truncation, and same-cursor forks;
- duplicate/reordered operations and crashes at every upload/commit/download/apply boundary;
- platform tests in Cloudflare Workers and Obsidian on supported macOS/iOS versions.

No independent security review is claimed. Before presenting Meridian as production-hardened, its protocol, implementation, release controls, and operational procedures should receive focused review even though external audit is not an MVP acceptance requirement.
