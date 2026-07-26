# Meridian protocol

Status: **draft protocol generation 1**. Wire compatibility is not promised before the first public release.

This document is normative for the generation-1 cryptographic envelope. The TypeScript codecs and published vectors in `packages/protocol` and `packages/crypto` are executable companion specifications. “MUST”, “SHOULD”, and “MAY” have their RFC 2119 meanings.

## Design invariants

- Cloudflare stores only ciphertext, public authorization data, opaque identifiers, and timing/size metadata.
- The operation log is append-only and hash-chained. A WebSocket message is only a cursor hint.
- A file revision is immutable. Deletes are revisions, and restoration creates a revision.
- A fresh random key protects every revision. Blob upload precedes operation commit.
- Every durable author statement is Ed25519-signed over one exact canonical representation.
- A device persists its accepted generation, cursor, and log hash before acknowledging progress.
- Concurrent user content is merged safely or materialized as a conflict; it is never silently discarded.

## Primitive suite

Every signed epoch selects the complete suite. Generation 1 is fixed as follows:

| Field | Value |
| --- | --- |
| protocol generation | `1` |
| encoding | deterministic CBOR, RFC 8949, Meridian subset v1 |
| hash | SHA-256 |
| KDF | HKDF-SHA-256 (`0x0001`) |
| content and recovery AEAD | AES-256-GCM (`0x0002`), 128-bit tag |
| revision-key wrapping | AES-256-KW / RFC 3394 (`A256KW`) |
| signatures | Ed25519 / RFC 8032, strict verification |
| pairing KEM | DHKEM(X25519, HKDF-SHA-256) (`0x0020`) |
| pairing | HPKE base mode / RFC 9180 with the KDF and AEAD above |

An algorithm change MUST create a new owner-authorized epoch with a higher protocol generation. An existing epoch's interpretation never changes.

## Binary types

Vault, device, file, revision, operation, epoch, blob, certificate, and pairing IDs are independent random 128-bit strings. They are byte strings in CBOR and unpadded base64url in HTTP JSON. Implementations MUST NOT derive an ID from a path, content, key, timestamp, or another ID.

SHA-256 values, Ed25519 public/private seeds, X25519 public/private keys, recovery seeds, vault epoch keys, and revision keys are 32 bytes. Ed25519 signatures are 64 bytes. AES-GCM nonces are 12 bytes. Wrapping a 32-byte revision key with AES-KW produces 40 bytes.

Compile-time brands prevent accidental interchange of same-sized values. Decoders still enforce every length at runtime.

## Deterministic CBOR

`encodeCanonical` implements the deterministic rules in RFC 8949 Section 4.2 for Meridian's deliberately small data model:

- unsigned and negative integers up to the CBOR 64-bit range;
- UTF-8 text, byte strings, arrays, text-keyed maps, booleans, and null;
- the shortest argument/length representation;
- definite lengths only;
- map keys ordered first by encoded length and then lexicographically by encoded bytes;
- exactly one top-level item.

Protocol CBOR forbids floating point, tags, simple values other than booleans/null, non-text map keys, invalid UTF-8, duplicate keys, cycles, and trailing data. A decoder MUST reject non-canonical key order and non-shortest integers rather than normalize and accept them. Closed protocol models reject missing and unknown fields. Resource limits bound bytes, nesting, arrays, and maps before application logic runs.

Signatures cover:

```text
canonical-cbor({
  domain: "meridian/v1/<object-domain>",
  body: <the exact unsigned body>
})
```

The domain is part of the signed bytes, preventing a valid signature for one model from authorizing another. Current domains are defined in `packages/protocol/src/constants.ts`.

## Key hierarchy and labels

```text
random 256-bit recovery seed
├── HKDF "meridian/v1/kdf/recovery-signing-seed"
│   └── Ed25519 recovery trust anchor
└── HKDF "meridian/v1/kdf/recovery-encryption-key"
    └── AES-256-GCM recovery-package key

random vault epoch key
└── HKDF "meridian/v1/kdf/revision-kek"
    context = { vaultId, epochId, revisionId }
    └── AES-256-KW KEK
        └── random revision key
            ├── encrypted revision metadata
            └── encrypted content chunks
```

Labeled derivation uses a 32-byte zero salt and canonical CBOR info `{ label, context }`. Labels and context shapes are versioned. Recovery signing and encryption keys are independent. Files are never encrypted directly with a recovery or epoch key.

Private key material exists only on authorized clients. The server receives the recovery public key, device public keys, certificates, signed epochs/checkpoints, and an encrypted recovery package.

### AES-GCM nonce rule

Every encryption under one revision key MUST use a unique random 96-bit nonce. A revision encryption context tracks all metadata and chunk nonces and rejects a duplicate before encryption. Random generation retries an accidental collision. A nonce may repeat under an independently random revision key.

Ciphertext includes WebCrypto's appended 128-bit GCM tag. Authentication failure is terminal for that object; plaintext MUST NOT be returned or partially applied.

### Associated data

Each revision object authenticates canonical associated data containing:

```text
protocol generation and complete cipher suite
vault ID and epoch ID
file ID and revision ID
operation type
object kind: "revision-metadata" or "content-chunk"
chunk index and total chunk count
```

Metadata uses index zero and a count of at least one. Content indices are zero-based and contiguous. The object-kind field prevents metadata/chunk substitution. The complete context prevents moving ciphertext between vaults, epochs, files, revisions, operations, or chunk positions.

## Device authorization

A device has an independent Ed25519 signing keypair and HPKE/X25519 keypair. A vault-scoped immutable certificate contains:

- random certificate, vault, and device IDs;
- both public keys;
- duplicate-free permissions in the fixed order `read`, `write`, `manage-devices`, `rotate-epoch`;
- a recovery issuer or an issuer certificate ID;
- authorized epoch and suite;
- first valid log cursor and optional expiry.

The recovery signing key signs initial certificates. A later certificate may be signed by an unexpired, unrevoked certificate with `manage-devices`. Validation walks at most 32 issuers, rejects cycles, requires one vault throughout, checks every signature and validity bound, and terminates at the recovery public key.

Certificate bytes never change. Revocation is a separately signed append-only operation naming the certificate. An owner may revoke another device; a non-owner member may revoke only itself; the owner may never self-revoke. Both the canonical lifecycle operation and its Worker log framing are signed, binding the operation, author, epoch, target device, target certificate, and reason. Revocation becomes effective at the assigned cursor. Clients verify both signatures and persist the target’s revocation cursor before advancing their checkpoint; later operations authored by that identity are rejected even after restart. The Worker atomically appends the revocation, deletes the target’s sessions, and rejects future authentication.

Before member self-removal, the plugin quiesces synchronization and durably stores the exact signed operation. Local keys and connection settings are cleared only after a successful response or an exact Meridian `device_not_found` response to a fresh authorization probe. Ambiguous network, HTML, generic 401, malformed, or unrelated 404 responses retain the keys and pending intent for retry after restart. Revocation cannot erase bytes already downloaded.

## Epochs and downgrade resistance

A signed epoch declaration binds vault and epoch IDs, monotonic sequence, previous epoch ID, complete suite, creator, and reason. The initial and recovery epochs are recovery-signed. Authorized devices with `rotate-epoch` may create routine, revocation, or migration epochs.

A client MUST verify epoch authorization before use, then durably record the greatest accepted protocol generation and epoch sequence. It rejects:

- a lower protocol generation;
- an older epoch sequence;
- different generations at one sequence;
- a transition whose previous ID does not match the accepted epoch;
- an old-epoch operation authored after a transition or applicable revocation.

Revoking a device SHOULD be followed by a new epoch and HPKE redistribution to remaining devices. Rotation gives no retroactive secrecy.

## Revisions and operations

Revision metadata is encrypted and contains normalized path, parent revision IDs, tombstone flag, text/binary type, total plaintext length, and a timestamp hint. The signed outer revision operation contains opaque IDs, author and epoch, wrapped revision key, encrypted metadata, and ordered encrypted chunk descriptors. It does not expose the path, parents, tombstone, or content type.

A producer:

1. captures a stable local snapshot;
2. normalizes and validates the path;
3. chooses random operation/revision/blob IDs and a random revision key;
4. encodes and encrypts metadata;
5. splits non-empty content into chunks no larger than 8 MiB and encrypts each;
6. derives the revision-specific KEK and wraps the revision key;
7. signs the operation;
8. uploads every named ciphertext blob;
9. submits the canonical operation with its stable idempotency ID.

A consumer verifies canonical encoding, suite/epoch policy, certificate status at the assigned cursor, operation signature, and hash chain before unwrapping. It authenticates metadata before loading content, then authenticates every blob and verifies signed plaintext lengths. It applies plaintext through the crash-safe local journal only after all checks pass.

An empty file has no content blobs and encrypted metadata with length zero. A tombstone also has no blobs but has `tombstone = true`. This distinction is encrypted.

## Ordered log and checkpoints

The Durable Object assigns cursors starting at 1. Entry hash is:

```text
SHA-256(canonical-cbor({
  domain: "meridian/v1/log-entry",
  vaultId,
  cursor,
  previousHash,
  operation: { body, signature }
}))
```

Cursor 0 has the all-zero 32-byte hash. Each returned entry MUST match the caller's prior hash. A signed checkpoint binds vault, epoch, cursor, log hash, signer device, and protocol generation.

Before acknowledging or advertising a newly applied cursor, a client durably persists its high-water mark. It rejects a lower cursor, lower generation, or a different hash at the same cursor. Pairing includes a signed trusted checkpoint. Recovery includes a public checkpoint commitment and the same checkpoint inside authenticated ciphertext.

This detects rollback and forks relative to locally retained state. It does not prove that two isolated devices see one global history; see the threat model.

## Authentication

A server challenge contains challenge ID, vault/device IDs, 32 random bytes, and expiry. The device signs canonical CBOR under the `meridian/v1/auth-challenge` domain, not the random bytes alone. A challenge is single-use and short-lived. A successful proof creates a short-lived bearer session. Session authentication controls API access; operation signatures provide durable authorship.

## Pairing

1. The new device generates both keypairs and a random device ID.
2. It signs a proof-of-possession request binding the pairing, vault, device, both public keys, and its self-declared device name and platform.
3. The server relays that public candidate package to the authenticated initiating device. The QR disappears as soon as that identity is fixed.
4. The existing device verifies the relayed request, creates a child certificate, and prepares an RFC 9180 HPKE transfer that remains only in its SecretStorage. `info` is SHA-256 of the context and AEAD associated data is the complete context. Plaintext binds vault, epoch, epoch key, checkpoint cursor, and checkpoint hash.
5. The pairing context binds the signed device descriptor, child certificate, complete issuer chain, recovery public key, current signed epoch, signed checkpoint, expiry, and complete suite.
6. The existing device uploads only a signed, ciphertext-free verification preview containing the context and SHA-256 hash of the locally withheld full transfer. The server does not receive the encrypted vault keys yet.
7. Both devices validate the preview, automatically display the same five-item phrase, and explicitly confirm that it matches. Each item maps one digest byte to one of 256 fixed prefix/suffix combinations, yielding a 40-bit manual check; repeated items are valid.
8. The existing device locally verifies the candidate’s signed confirmation. Only then does it upload the hash-bound encrypted transfer for relay. Before then, even a malicious server cooperating with a QR holder has neither an authorized device nor vault key material.
9. The new device verifies that the released transfer matches the confirmed hash, then validates the complete certificate chain, transfer signature, epoch signature, checkpoint signature, expiry, identity, and phrase before HPKE open.
10. The new device persists the recovered key bundle and signs a completion acknowledgement.
11. The server atomically inserts the device into the authorized registry only after that acknowledgement. Cancellation or expiry before release leaves no authorized device and removes the withheld transfer.

A pairing capability is server-side, short-lived, and single-use. The QR code is only a transport for that capability. Obsidian pairing URIs prefix every query parameter with `meridian` and never use Obsidian-reserved routing keys such as `vault`. Server relay and polling are not substitutes for proof-of-possession, signed transcript validation, HPKE, or phrase verification.

## Recovery

The recovery code encodes 256 random seed bits plus a 32-bit checksum in a versioned, grouped unpadded-base64url form. It is high-entropy ownership material, not a password. The server never receives it.

The AES-GCM recovery package includes vault, current signed epoch and key, the bounded historical epoch keyring, signed checkpoint, and monotonic recovery sequence. Associated data binds the recovery domain, vault, generation, KDF, and AEAD. A clear signed checkpoint is stored beside it and MUST match the authenticated inner checkpoint.

Recovery derives keys locally, authenticates and decrypts the package, verifies its signatures/checkpoint, proves possession against a server challenge, registers a replacement owner device, revokes lost certificates, and creates a new recovery-signed epoch. If all devices are gone, the user should compare the checkpoint with an independently retained copy before proceeding.

An optional password MAY encrypt the already high-entropy recovery material only with a separately specified, versioned Argon2id profile. Generation 1 deliberately exposes no password-only recovery API; a low-entropy password never replaces the seed.

## Filesystem normalization and conflicts

Paths MUST be relative, use `/`, contain no NUL, `.` or `..` segments, and be Unicode NFC. The active sync engine supplements exact-path identity with Unicode default case-fold collision detection for case-insensitive filesystems. Timestamp and modification-time values are hints, never causality.

Revision parent sets define the DAG. For concurrent heads:

- deterministic three-way merge handles non-overlapping valid UTF-8 changes;
- overlapping/unsafe text and all binary conflicts preserve each branch;
- delete/edit keeps the tombstone at the original path and materializes the edit as recovered content;
- rename/content may merge only when stable file identity and ancestry are unambiguous;
- rename/rename chooses the lexicographically smallest normalized UTF-8 path as canonical and preserves alternatives;
- a conflict filename includes short device and revision IDs, making retries deterministic;
- resolving or restoring creates a new revision referencing every resolved head.

When platform path constraints make the deterministic name unavailable, the engine appends an increasing deterministic suffix derived from sorted revision IDs. No branch is deleted merely because another branch wins a path.

## Transport and limits

HTTP JSON uses unpadded base64url for binary control fields. Durable signed bodies remain canonical CBOR bytes. Boundary schemas reject excess properties. Implementations MUST bound body size, array counts, string lengths, cursors, chunk sizes, and decomposed allocations before cryptography or storage.

Blob names are `vaults/<opaque vault id>/blobs/<opaque blob id>`. R2 remains private. The Worker authenticates access and streams ciphertext without decrypting it. Notifications contain only an advanced cursor and are never authoritative.

## Test vectors

- `packages/protocol/test/vectors/canonical-cbor.json`: accepted and rejected canonical encodings.
- `packages/crypto/test/vectors/hpke-x25519-aes256.json`: CFRG RFC 9180-format vector for the selected suite.
- Primitive tests cover RFC 5869 HKDF, RFC 8032 Ed25519, NIST AES-256-GCM, RFC 3394 AES-256-KW, and HPKE.
- Workflow tests cover setup/recovery, bundle serialization, authentication, chunked revision encryption/tamper rejection, and complete pairing.
