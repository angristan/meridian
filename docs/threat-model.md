# Meridian threat model

Status: Draft, protocol generation 1.

Meridian is a sync system. It must not be the only backup of a vault.

## Terms

- **Plaintext** is readable data. **Ciphertext** is encrypted data.
- An **endpoint** is an authorized Meridian device.
- **E2EE** keeps plaintext and keys on endpoints.
- A Cloudflare **Worker** handles requests. A **Durable Object** stores ordered SQLite state. **R2** stores encrypted files.
- An **epoch** uses one vault key.
- A **cursor** is a log position. A **checkpoint** records a cursor and hash. A **high-water mark** is the newest saved checkpoint.
- **AEAD** encrypts data and detects changes. Its unencrypted associated data is also protected from changes.
- **Canonical CBOR** is the one allowed binary encoding.
- **HPKE** encrypts to a recipient's public key.
- A **capability** is a random token for a limited action.
- A **CAS** update succeeds only when the old value still matches.

## Scope

Meridian syncs one user's Obsidian vault through a self-hosted Worker, one Durable Object, and private R2. It supports macOS and foreground iOS plugins.

This model covers protocol, storage, network, device, recovery, release, and update risks. It cannot protect an endpoint that reads the vault while compromised.

## Assets

Secrets:

- notes, paths, attachments, and selected Obsidian settings;
- the recovery seed and derived recovery private keys;
- current and historical vault epoch keys;
- device Ed25519 and X25519 private keys;
- random per-revision content keys; and
- valid setup, pairing, session, and upload capabilities.

Integrity assets:

- file revision graphs and conflict branches;
- device authorization and revocation history;
- epoch and protocol-generation history;
- the ordered log cursor, hash, and signed checkpoints;
- release files and plugin update metadata; and
- local journal state used for crash-safe apply.

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

Trusted for secrecy and correct local behavior:

- the device OS, Obsidian, installed plugins, and Meridian bundle;
- WebCrypto and pinned, audited cryptographic dependencies;
- device secret storage and recovery-material handling;
- local journal and checkpoint code; and
- the plugin build and release process.

Not trusted with plaintext or vault keys:

- Cloudflare, Worker operators, Durable Object storage, or R2;
- networks, DNS, or notification delivery; and
- other devices until their full authorization chain and pairing transcript verify.

The server provides availability and ordering. Clients verify its cryptographic output.

## Adversaries and limits

The design considers:

1. A passive observer measuring connections, timing, and sizes.
2. An active attacker replaying, delaying, reordering, cutting off, or replacing traffic. Checked TLS and cryptography still hold.
3. Malicious Cloudflare reading or changing all server state, isolating clients, hiding operations, or lying about cursors.
4. A person with a setup, session, or pairing token, but no device or recovery key.
5. A lost or stolen device, before or after revocation.
6. A malicious vault file, attachment, or ciphertext attacking parsers or resources.
7. A compromised dependency, CI workflow, release, Obsidian update, or plugin update.
8. Another plugin with the same plaintext and API access.
9. Corruption, crashes, partial uploads, wrong clocks, path collisions, or user mistakes.

The design cannot prevent:

- a fully compromised authorized endpoint while it holds plaintext and keys;
- attacks that break the selected standard cryptography;
- coercion or physical viewing of a recovery code or pairing phrase;
- traffic analysis; Meridian has no cover traffic or storage-size hiding; or
- service loss after account deletion, Cloudflare outage, or deliberate data destruction.

## Security goals

### Confidentiality

The server must not learn plaintext content, paths, revision parents, deletion markers, content types, selected settings, epoch or revision keys, device private keys, or recovery material. Application traffic must give a network attacker no more information than the server sees.

A revoked device must not get future epoch keys. Rotation cannot erase plaintext, ciphertext, or keys it already got.

### Integrity

A client accepts an operation only after all required checks pass. It verifies canonical encoding, the allowed suite, hash-chain continuity, authorization, signatures, key unwrap, AEAD tags, chunk positions, and plaintext lengths.

Recovery, certificates, epochs, pairing transfers, and checkpoints use separate signature domains. No concurrent revision is silently removed. Materializing conflicts and restoring data add history; they do not rewrite it.

### Rollback and downgrade detection

A saved high-water mark lets a device detect rollback and downgrade. It detects a lower cursor, a changed hash, log truncation or forks, an older epoch, and an unauthorized lower protocol generation. A newly paired device gets a signed checkpoint in the full pairing transcript.

### Availability and recovery

The vault works offline. Push and pull can retry and resume. Immutable blobs upload before commit, so a partial push is not authoritative. A local journal applies data before advancing the cursor.

High-entropy recovery material can restore ownership after all devices are lost. The rollback limit in [Recovery limitations](#recovery-limitations) still applies.

## Mitigations by threat

Each item lists the protection first, then the risk that remains.

- **Server reads storage**
  - Protection: Client E2EE, private R2, random keys, and opaque IDs.
  - Remaining risk: Sizes, timing, device links, and stable opaque access remain visible.
- **Ciphertext moves to another context**
  - Protection: AEAD data binds the suite, vault, epoch, file, revision, object kind, operation, and position.
  - Remaining risk: None if AEAD is secure and all inputs are correct.
- **Operation tampering**
  - Protection: Strict canonical CBOR, Ed25519 domain signatures, and a hash chain.
  - Remaining risk: The server can hide a valid operation.
- **Nonce reuse**
  - Protection: Fresh revision keys, random 96-bit nonces, and a per-revision duplicate registry.
  - Remaining risk: A faulty random generator can be catastrophic. Meridian trusts the platform generator.
- **Replay or duplicate requests**
  - Protection: Stable operation and exact-retry IDs plus one append transaction.
  - Remaining risk: Resource exhaustion still needs server rate limits.
- **Stolen session**
  - Protection: Short expiry and exact authorization checks.
  - Remaining risk: The bearer can act until expiry, within certificate permissions.
- **Pairing interception**
  - Protection: Signed device data, ciphertext-free preview, two phrase confirmations, locally held HPKE data, a full signed transcript, the certificate chain, a 40-bit phrase, and short expiry.
  - Remaining risk: A user can approve a mismatch. An attacker gets one guess in 2^40 per attempt.
- **Lost device**
  - Protection: Revoke its certificate, reject later operations and sessions, then rotate for exactly the remaining devices.
  - Remaining risk: Old keys and downloaded history cannot be erased.
- **Stale or malicious recovery package**
  - Protection: An authorized version-2 HPKE package, vault-bound context, required transition ID, public state ID, and predecessor CAS.
  - Remaining risk: A malicious server can roll back all stored state. Detection after all devices are lost needs an independent checkpoint.
- **Server rollback**
  - Protection: Save the cursor, hash, and generation. Transfer signed checkpoints.
  - Remaining risk: Isolated devices can receive different valid views.
- **Protocol downgrade**
  - Protection: Put the full suite in the signed epoch. Save the highest generation and sequence.
  - Remaining risk: A compromised endpoint can lower its own saved minimum.
- **Parser attack**
  - Protection: Closed schemas, strict canonical input, and limits on bytes, depth, collections, and chunks.
  - Remaining risk: Host memory pressure still needs platform tests.
- **Partial write or crash**
  - Protection: Immutable blobs and revisions, byte reservation, R2 confirmation, server transactions, and the local apply journal.
  - Remaining risk: Abandoned ciphertext needs conservative cleanup.
- **Storage exhaustion**
  - Protection: Pressure warnings, lossless compaction, conservative cleanup, and fail-closed IndexedDB transactions.
  - Remaining risk: Infinite history grows without limit. Cloudflare or browser limits can stop writes.
- **Wrong clock**
  - Protection: Parents and cursors set causality. Timestamps are hints.
  - Remaining risk: Expiry needs a reasonable local and server time policy.
- **Path collision**
  - Protection: Unicode NFC, relative paths, case-fold checks, and deterministic conflict names.
  - Remaining risk: Adapters need tests for reserved platform names.
- **Malicious notification**
  - Protection: Notifications are hints. HTTP pull is authoritative.
  - Remaining risk: Reconnect storms need backoff and rate limits.
- **Setup-token leak**
  - Protection: High entropy, no QR or log copy, a short setup session, and permanent claimed state.
  - Remaining risk: A leak before the real claim can race setup.
- **Other Obsidian plugin**
  - Protection: No protocol mitigation.
  - Remaining risk: It can read plaintext and may reach in-process secrets.
- **Compromised release**
  - Protection: Pinned dependencies, reviewable builds, CI checks, and signed repository controls.
  - Remaining risk: A trusted malicious update can steal all local secrets.

## Malicious server analysis

The server can deny service, delete ciphertext, delay devices, and return stale or different valid prefixes. It sees IP addresses, platform hints, timing, ciphertext sizes, chunk counts, storage, cursor lag, opaque blob access, devices, and public authorization links. Isolation before checkpoint comparison can maintain separate valid histories.

It cannot forge recovery or device signatures, authenticate changed ciphertext, unwrap revision keys, or move objects between authenticated contexts undetected.

Checkpoints detect rollback against known state. They do **not** prove one global history. Devices that never compare them can remain on valid forks. Future work may add checkpoint sharing or a public log. Until then, compare checkpoints when integrity is in doubt.

## Endpoint compromise

Obsidian and Meridian must read plaintext. Malware, another plugin, debugger access, a compromised OS, or a malicious release can read or change all local data and impersonate the device.

SecretStorage improves at-rest handling, but cannot isolate secrets from Obsidian code. After detection, remove the device, rotate from a trusted device or recovery, and inspect its signed revisions. This limits future damage but cannot restore secrecy for data already read.

## Recovery limitations

The recovery seed is a random 256-bit root capability. Keep it outside the vault, preferably in separate secure locations. A screenshot, vault note, low-entropy replacement, or cloud clipboard defeats the model.

The authenticated server package can be old. Predecessor CAS stops an old package from replacing a newer one. It cannot stop server rollback of the package, public state ID, and history together.

A surviving device detects this with its checkpoint. If every device and independent checkpoint is lost, the seed proves ownership and decrypts the package. It cannot reveal hidden later state. Treat the server checkpoint as newest available, not proof that no later state existed.

A password may only add Argon2id wrapping around high-entropy recovery material. Password-only recovery is excluded because the server package allows offline guessing.

## iOS and offline limits

iOS has no reliable background execution. Suspension can stop requests and sockets. Correctness depends only on durable HTTP state, local journaling, and resume reconciliation. Lost WebSockets, duplicate hints, and long offline periods must not lose data.

Whole-file APIs can use too much memory. Generation 1 sends 4–8 MiB ciphertext chunks, but snapshots may still hold the full source file. New installations use a 64 MiB whole-file limit and at most four concurrent chunk transfers. Upgrades keep a previously higher limit for compatibility. A client never marks a cursor applied after interruption or out-of-memory.

## Operational assumptions

- TLS certificate checks stay enabled. Application encryption does not justify bypassing TLS.
- Capabilities are random, scoped, rate-limited, short-lived, and single-use where needed. Logs record only the result class.
- Logs and traces never contain tokens, unnecessary stable IDs, envelope bodies, plaintext, paths, keys, recovery codes, or pairing plaintext.
- R2 is private. Only authenticated Worker routes access it.
- Garbage collection never deletes committed history. Signed acknowledgements are telemetry until a generation-aware archive and safe restart path exist. Cleanup removes only disposable local records, expired capabilities, obsolete recovery receipts, and old unreferenced uploads.
- Sync is not backup. Users keep versioned backups and test export and restore.
- Real macOS and iOS tests cover suspend and resume, large files, Unicode and case collisions, and interrupted apply before production use.

## Security validation

Required automated tests include:

- published HKDF, Ed25519, AES-GCM, AES-KW, HPKE, and canonical-CBOR vectors;
- rejection of non-canonical, duplicate, unknown-field, trailing, malformed-length, and over-limit input;
- signature, tag, wrapped-key, associated-data, phrase, transcript, and proof-of-possession tampering;
- expired, cyclic, cross-vault, unauthorized, and revoked certificate chains;
- stale epochs, suite downgrade, cursor rollback, truncation, and same-cursor forks;
- duplicate or reordered operations and crashes at every upload, commit, download, and apply boundary; and
- Cloudflare Worker and Obsidian tests on supported macOS and iOS versions.

**Meridian has not received an independent security review.** Before calling it production-hardened, experts should review its protocol, code, release controls, and operations. An external audit is not required for the current pre-release milestone. It does not replace focused review.
