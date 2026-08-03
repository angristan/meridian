# Meridian protocol

Status: **draft protocol generation 1**. Generation-1 wire compatibility can change while Meridian is pre-release.

This document defines the generation-1 cryptographic envelope. It is normative. The TypeScript codecs and vectors in `packages/protocol` and `packages/crypto` are executable companion specifications. **MUST**, **SHOULD**, and **MAY** have their RFC 2119 meanings.

## Core rules

- Cloudflare stores ciphertext, public authorization data, opaque IDs, and timing and size metadata. It does not receive plaintext or private keys.
- The operation log is ordered, append-only, safe to retry without duplicate effects, and hash-chained. WebSocket messages are cursor hints only.
- File revisions are immutable. A delete is a revision. A restore creates a revision.
- Each revision uses a fresh random key. All blobs are uploaded before operation commit.
- Each durable author statement is Ed25519-signed over one exact canonical representation.
- A device persists its accepted generation, cursor, and log hash before it reports progress.
- Concurrent content is merged safely or kept as a conflict. It is never silently discarded.

## Primitive suite

An **epoch** is a versioned vault key state. Each signed epoch selects the full suite.

| Field | Generation-1 value |
| --- | --- |
| Protocol generation | `1` |
| Encoding | Deterministic CBOR, RFC 8949, Meridian subset v1 |
| Hash | SHA-256 |
| Key derivation (KDF) | HKDF-SHA-256 (`0x0001`) |
| Authenticated encryption (AEAD) for content and recovery | AES-256-GCM (`0x0002`), 128-bit tag |
| Revision-key wrapping | AES-256-KW, RFC 3394 (`A256KW`) |
| Signatures | Ed25519, RFC 8032, strict verification |
| Pairing key exchange (KEM) | DHKEM(X25519, HKDF-SHA-256) (`0x0020`) |
| Pairing public-key encryption (HPKE) | HPKE base mode, RFC 9180, with the KDF and AEAD above |

An algorithm change MUST use a new owner-authorized epoch with a higher protocol generation. An existing epoch's meaning never changes.

## Binary types and sizes

Vault, device, file, revision, operation, epoch, blob, certificate, and pairing IDs are independent random 128-bit strings. CBOR uses byte strings. HTTP JSON uses unpadded base64url. Implementations MUST NOT derive an ID from a path, content, key, timestamp, or another ID.

| Value | Size |
| --- | --- |
| SHA-256 value | 32 bytes |
| Ed25519 public key or private seed | 32 bytes |
| X25519 public or private key | 32 bytes |
| Recovery seed, epoch key, or revision key | 32 bytes |
| Ed25519 signature | 64 bytes |
| AES-GCM nonce | 12 bytes |
| AES-KW output for a 32-byte revision key | 40 bytes |

Compile-time brands prevent accidental use of one same-sized type as another. Decoders enforce every size at runtime.

## Deterministic CBOR

`encodeCanonical` implements RFC 8949 Section 4.2 for the Meridian data model. It allows:

- unsigned and negative integers in the CBOR 64-bit range;
- valid UTF-8 text, byte strings, arrays, and text-keyed maps;
- booleans and `null`.

It requires the shortest argument or length form, definite lengths, and exactly one top-level item. Map keys sort first by encoded length, then lexicographically by encoded bytes.

Protocol CBOR forbids floating point, tags, other simple values, non-text map keys, invalid UTF-8, duplicate keys, cycles, and trailing data. A decoder MUST reject non-canonical key order and non-shortest integers. It MUST NOT normalize and accept them. Closed models reject missing and unknown fields. Resource limits bound bytes, nesting, arrays, and maps before application logic.

Signatures cover:

```text
canonical-cbor({
  domain: "meridian/v1/<object-domain>",
  body: <the exact unsigned body>
})
```

The signed domain prevents one model's signature from authorizing another. `packages/protocol/src/constants.ts` defines current domains.

## Keys and encryption

```text
random 256-bit recovery seed
+-- HKDF "meridian/v1/kdf/recovery-signing-seed" -> Ed25519 trust anchor
+-- HKDF "meridian/v1/kdf/recovery-encryption-key" -> AES-GCM package key

random vault epoch key
+-- HKDF "meridian/v1/kdf/revision-kek"
    context = { vaultId, epochId, revisionId }
    +-- AES-KW key-encryption key -> random revision key
        +-- encrypted metadata and content chunks
```

Labeled derivation uses a 32-byte zero salt and canonical CBOR info `{ label, context }`. Labels and context shapes are versioned. Recovery signing and encryption keys are independent. Files are never encrypted directly with a recovery or epoch key.

Private keys exist only on authorized clients. The server receives the recovery and device public keys, certificates, signed epochs and checkpoints, and an encrypted recovery package.

### Nonces and authentication

Every encryption under one revision key MUST use a unique random 96-bit nonce. A revision context tracks metadata and chunk nonces. It rejects duplicates before encryption. Random generation retries collisions. A nonce may repeat under an independently random revision key.

Ciphertext includes WebCrypto's appended 128-bit GCM tag. Authentication failure is final for that object. Plaintext MUST NOT be returned or partly applied.

### Associated data

Each encrypted revision object authenticates canonical associated data with:

- the protocol generation and full cipher suite;
- vault, epoch, file, and revision IDs;
- operation type;
- object kind: `revision-metadata` or `content-chunk`;
- chunk index and total count.

Metadata uses index zero and a count of at least one. Content indices are zero-based and contiguous. The kind prevents metadata and chunk substitution. The full context prevents moving ciphertext between vaults, epochs, files, revisions, operations, or chunk positions.

## Device authorization

Each device has independent Ed25519 signing and HPKE/X25519 keypairs. An immutable vault certificate contains:

- random certificate, vault, and device IDs;
- both public keys;
- duplicate-free permissions in fixed order: `read`, `write`, `manage-devices`, `rotate-epoch`;
- a recovery issuer or issuer certificate ID;
- issuance epoch and suite;
- first valid log cursor and optional expiry.

The certificate remains valid across later signed epochs. The recovery key signs initial certificates. A later certificate may be signed by an unexpired, unrevoked certificate with `manage-devices`.

Validation walks at most 32 issuers. It rejects cycles, requires one vault throughout, verifies every signature and validity bound, and ends at the recovery public key.

### Revocation

Certificate bytes never change. Revocation is a separate signed append-only operation naming the certificate. An owner may revoke another device. A non-owner may revoke only itself. The owner may never self-revoke.

Both the canonical lifecycle operation and its Worker log framing are signed. They bind the operation, author, epoch, target device, target certificate, and reason.

Revocation takes effect at its assigned cursor. Clients verify both signatures and persist the target revocation cursor before advancing their checkpoint. They reject later operations by that identity, including after restart.

The Worker atomically appends the revocation, deletes target sessions, and rejects future authentication. Revocation cannot erase downloaded bytes.

Before member self-removal, the plugin stops sync and durably stores the exact signed operation. It clears keys and connection settings only after success or an exact Meridian `device_not_found` response to a fresh authorization probe. Network errors, HTML, generic `401`, malformed responses, and unrelated `404` responses keep the keys and pending intent for retry after restart.

## Epochs and downgrade resistance

A signed epoch declaration binds the vault and epoch IDs, monotonic sequence, previous epoch ID, full suite, creator, and reason. The recovery key signs initial and recovery epochs. A device with `rotate-epoch` may create routine, revocation, or migration epochs.

### Routine transition

The owner signs a routine transition under the predecessor epoch. It binds:

- the exact predecessor cursor and hash;
- the next declaration;
- one HPKE key package for each active device;
- the previous recovery state ID;
- a replacement encrypted recovery package.

Each key package binds the vault, operation, predecessor, successor, and recipient. The Worker requires the exact active-device recipient set.

In one Durable Object transaction, the Worker appends the transition, advances the authoritative epoch, replaces recovery state by predecessor compare-and-swap (CAS), and cancels incomplete pairings.

The transition is the last operation authorized by the predecessor epoch. Later operations must name the successor. A concurrent write, pairing completion, recovery, or second rotation invalidates a prepared transition. The client must pull and rebuild it exactly.

Before use, a client MUST verify epoch authorization, decrypt its package, replace its full SecretStorage bundle, and only then advance the IndexedDB cursor. Prepared revisions keep exact plaintext but discard predecessor ciphertext for re-encryption.

The client durably records the greatest accepted generation and epoch sequence. It rejects:

- a lower generation or older sequence;
- different generations at one sequence;
- a transition whose previous ID differs from the accepted epoch;
- an old-epoch operation authored after a transition or applicable revocation.

Device revocation creates another epoch that excludes revoked devices. Rotation gives no retroactive secrecy. Pairing after rotation transfers the current key and bounded historical keyring. A committed rotation fences an in-progress pairing.

## Revisions and operations

Encrypted revision metadata contains the normalized path, parent revision IDs, tombstone flag, text or binary type, total plaintext length, and timestamp hint.

The signed outer operation contains opaque IDs, author, epoch, wrapped revision key, encrypted metadata, and ordered encrypted chunk descriptors. It does not expose the path, parents, tombstone, or content type.

A producer:

1. Captures a stable snapshot, then normalizes and validates the path.
2. Chooses random operation, revision, and blob IDs, plus a random revision key.
3. Encodes and encrypts metadata and chunks. Non-empty chunks are at most 8 MiB.
4. Derives the revision key-encryption key and wraps the revision key.
5. Signs the operation and uploads every named ciphertext blob.
6. Submits the canonical operation with its stable exact-retry ID.

Before unwrapping, a consumer verifies canonical encoding, suite and epoch policy, certificate status at the assigned cursor, operation signature, and hash chain. It authenticates metadata before content. It then authenticates every blob and verifies signed plaintext lengths. Only then does the crash-safe local journal apply plaintext.

An empty file has no blobs and encrypted length zero. A tombstone also has no blobs but has `tombstone = true`. This difference is encrypted.

## Ordered log and checkpoints

The Durable Object assigns cursors from 1. The entry hash is:

```text
SHA-256(canonical-cbor({
  domain: "meridian/v1/log-entry",
  vaultId,
  cursor,
  previousHash,
  operation: { body, signature }
}))
```

Cursor 0 has an all-zero 32-byte hash. Each returned entry MUST match the caller's previous hash.

A signed checkpoint binds the vault, epoch, cursor, log hash, signer device, generation, initial log format, and format used after that checkpoint.

### Read-only legacy history

Old deployments used `legacy-http-v1`. It hashes the previous hash, outer HTTP operation signing bytes, and outer signature with the deployed length-prefixed `log-chain/v1` framing. Legacy checkpoints omit log-format fields and decode as legacy from cursor zero.

Some immutable histories contain one signed `log-format-transition` as their last legacy-hashed entry. Its body commits to the exact previous cursor and hash and selects `canonical-cbor-v1`. The next entry uses the canonical formula.

Clients keep a read-only verifier for initial pull, resumed pull, and history backfill. They do not rewrite old entries. Current clients cannot create this transition. New vaults and all current writes require canonical hashing.

### Checkpoint rules

Before reporting a newly applied cursor, a client durably stores its high-water mark and current log format. It rejects a lower cursor, lower generation, format downgrade, or different hash or format at the same cursor.

Pairing includes a signed trusted checkpoint. Recovery stores a public checkpoint commitment and the same checkpoint inside authenticated ciphertext.

This detects rollback and forks relative to retained local state. It does not prove that isolated devices see one global history. See [Threat model](threat-model.md).

## Authentication

A server challenge contains its ID, vault and device IDs, 32 random bytes, and expiry. The device signs canonical CBOR under `meridian/v1/auth-challenge`, not the random bytes alone. The challenge is short-lived and single-use. A valid proof creates a short-lived bearer session.

Session authentication controls API access. Operation signatures provide durable authorship.

## Pairing

A pairing capability is server-side, short-lived, and single-use. The QR only transports it.

1. The new device creates both keypairs and a random device ID.
2. It signs proof of possession binding the pairing, vault, device, both public keys, and its declared device name and platform.
3. The server relays this public package to the authenticated initiating device. The QR disappears when that identity is fixed.
4. The existing device verifies the request and creates a child certificate. It prepares an RFC 9180 HPKE transfer that stays in SecretStorage. `info` is SHA-256 of the context. AEAD associated data is the full context. Plaintext binds the vault, epoch and key, and checkpoint cursor and hash.
5. The context binds the signed device descriptor, child certificate, exact approver-to-recovery issuer chain, recovery public key, current signed epoch, signed checkpoint, expiry, and full suite. Unrelated current or revoked certificates are registry history, not chain members.
6. The existing device uploads only a signed ciphertext-free preview with the context and SHA-256 hash of the withheld transfer. The server has no encrypted vault keys yet.
7. Both devices validate the preview and show the same five-item phrase. The user explicitly confirms a match. Each item maps one digest byte to one of 256 fixed prefix/suffix pairs. This is a 40-bit manual check. Repeats are valid.
8. The existing device verifies the candidate's signed confirmation locally. Only then does it upload the hash-bound encrypted transfer. Before this, a malicious server working with a QR holder has neither an authorized device nor vault keys.
9. The new device checks the confirmed hash. Before HPKE open, it validates the full certificate chain, transfer, epoch and checkpoint signatures, expiry, identity, and phrase.
10. It persists the recovered key bundle and signs completion.
11. Only then does the server atomically authorize the device. Cancellation or expiry before release authorizes no device and removes the withheld transfer.

Each side stores its exact signed join, approval, release, or completion material in SecretStorage before transmission. After a lost response, it checks server state and replays the same material. It does not create another identity or transfer.

Closing a modal after phrase confirmation pauses presentation. It does not race cancellation against release. After both confirmations release the transfer, QR expiry does not block signed completion.

Ordinary settings contain only a non-secret completion marker. Capabilities and cryptographic payloads stay in SecretStorage.

Obsidian pairing URI query names start with `meridian`. They never use a reserved routing key such as `vault`. Relay and polling do not replace proof of possession, signed transcript checks, HPKE, or phrase checks.

## Recovery

The recovery code contains 256 random seed bits and a 32-bit checksum. It uses a versioned, grouped, unpadded-base64url form. It is high-entropy ownership material, not a password. The server never receives it.

Version-2 packages use HPKE to the recovery signing key converted to X25519 by the reviewed curve conversion. Encrypted plaintext contains:

- the vault, current signed epoch, and epoch key;
- the bounded historical keyring and checkpoint;
- a monotonic recovery sequence;
- an authorized device signature with its recovery-rooted chain.

Owner-created epoch updates also bind the required transition operation ID. Associated data binds the recovery domain, vault, generation, KDF, and AEAD. A clear signed checkpoint sits beside the ciphertext and MUST match the authenticated inner checkpoint. Older package formats are rejected.

The public recovery state ID is SHA-256 of canonical, domain-separated bytes containing the vault ID and exact serialized encrypted package. A version-2 claim signs a stable attempt ID, previous recovery state ID, challenge, replacement identity, and replacement package.

Recovery derives keys locally, opens and authenticates the package, verifies signatures and checkpoint, proves possession to the server, registers a replacement owner, revokes lost certificates, and creates a recovery-signed epoch.

The Durable Object replaces the package only when the current state ID matches the signed predecessor. Package replacement, device replacement, challenge use, and an exact-retry receipt commit in one transaction. A stale claim does not consume its challenge. An exact retry returns its original result.

If all devices are gone, the user SHOULD compare the checkpoint with an independent copy before continuing.

An optional password MAY encrypt the high-entropy recovery material only with a separate, versioned Argon2id profile. Generation 1 has no password-only recovery API. A low-entropy password never replaces the seed.

## Paths and conflicts

Paths MUST be relative, use `/`, contain no NUL, `.` or `..` segments, and use Unicode NFC. On case-insensitive filesystems, the sync engine also detects Unicode default case-fold collisions. Timestamps and modification times are hints, never causality.

Revision parents define a directed acyclic graph. For concurrent heads:

- deterministic three-way merge handles non-overlapping valid UTF-8 changes;
- overlapping or unsafe text and all binary conflicts preserve each branch;
- delete/edit keeps the tombstone at the original path and stores the edit as recovered content;
- rename/content merges only with clear stable identity and ancestry;
- rename/rename picks the lexicographically smallest normalized UTF-8 path and preserves alternatives;
- conflict names include short device and revision IDs, so retries are deterministic;
- resolve or restore creates a revision that references every resolved head.

If platform rules reject the deterministic name, the engine adds an increasing deterministic suffix from sorted revision IDs. A branch is never deleted only because another wins a path.

## Retention and blob upload

Generation 1 retains committed history forever. It does not age-prune operations, referenced ciphertext, revision graph metadata, conflicts, checkpoints, encrypted snapshots, revoked-device records, or epoch keys needed for retained revisions.

After full sync, a device signs `retention-acknowledgement/v1` over vault ID, device ID, cursor, log hash, current epoch ID, and `historyRetention = forever`. The Worker accepts only an active device's monotonic acknowledgement on an authoritative cursor and hash and the current epoch. Revoked devices do not count.

This is progress status, not permission to compact the log. It has no snapshot or archive root and no generation for safely starting a device from an archive.

Blob upload uses a lease:

1. The authenticated client supplies the exact ciphertext length. The Durable Object records or refreshes a claim.
2. The Worker streams immutable ciphertext to private R2.
3. The Durable Object confirms the object and size, catalogs it, and releases the claim.

A revision is accepted only when every public blob ID in its canonical body resolves to stored R2 data. Exact retries do not duplicate catalog entries. Expired claims are disposable after 24 hours.

Unreferenced objects may be deleted only after seven days and only when an owner starts deletion. Every deletion recalculates reachability from all retained canonical revision operations.

## Transport and limits

HTTP JSON uses unpadded base64url for binary control fields. Durable signed bodies stay canonical CBOR. Boundary schemas reject extra properties.

Before cryptography or storage, implementations MUST bound body size, array counts, string lengths, cursors, chunk sizes, and decomposed allocations.

Blob names are `vaults/<opaque vault id>/blobs/<opaque blob id>`. R2 is private. The Worker authenticates access and streams ciphertext without decrypting it. Notifications contain only an advanced cursor and are never authoritative.

## Test vectors

- `packages/protocol/test/vectors/canonical-cbor.json`: accepted and rejected canonical encodings.
- `packages/crypto/test/vectors/hpke-x25519-aes256.json`: CFRG RFC 9180-format vector for this suite.
- Primitive tests cover RFC 5869 HKDF, RFC 8032 Ed25519, NIST AES-256-GCM, RFC 3394 AES-256-KW, and HPKE.
- Workflow tests cover setup and recovery, bundle serialization, authentication, chunked revision encryption and tamper rejection, and complete pairing.
