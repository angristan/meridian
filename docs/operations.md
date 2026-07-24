# Operations

## Core invariants

- Cloudflare never receives plaintext vault keys, paths, metadata, or file content.
- The Durable Object operation log is authoritative; WebSockets are notification hints only.
- R2 objects are immutable encrypted chunks referenced by committed revisions.
- A local cursor advances only after an operation is verified and safely applied.
- Concurrent user content is merged or preserved explicitly, never silently discarded.

## Health and status

`GET /health` reports only deployment health and safe protocol metadata. Authenticated plugin views report device status, local/remote cursors, pending work, conflicts, and the most recent sanitized failure.

Use Workers Logs and Traces to diagnose request classes, latency, binding failures, cursor lag, reconnects, retries, and encrypted byte counts. Never log setup/session tokens, keys, recovery material, file paths, envelope bodies, or stable identifiers that are unnecessary for diagnosis.

## Incident response

### Lost device

The Worker owner API can revoke a device and immediately blocks its sessions and writes. Generation 1 does not yet distribute a rotated epoch to only the remaining devices. For a suspected key compromise, use the recovery flow from a trusted replacement device; it revokes every old device and rotates the epoch.

Neither flow can erase plaintext or old epoch keys already obtained by a device.

### Lost all devices

1. Install Meridian on a replacement device.
2. Select recovery and enter the Worker URL and offline recovery material.
3. Confirm **Recover and revoke devices**. The plugin verifies and decrypts the package locally.
4. Meridian registers a fresh owner, revokes every previous device/session, rotates the epoch, and retains old epoch keys locally for history.

A server controlling the only surviving recovery package can withhold it or present a version no newer than the last independently retained checkpoint.

### Suspected server rollback

Stop writes. Preserve the local journal, highest trusted cursor, log hash, and signed checkpoints from every available device. Do not reset a device or overwrite its local state before comparing checkpoints.

### Mass deletion or corruption

Pause synchronization on another device before opening it. Use immutable history to inspect and restore affected revisions. Restoration creates new revisions and does not rewrite the audit trail.

## Backup

Synchronization is not a backup. Keep a separate backup of the plaintext vault and offline recovery material. The Worker code version does not snapshot Durable Object SQLite or R2. R2 history retention protects application revisions only while their chunks remain retained.

## Retention and garbage collection

Automatic garbage collection remains disabled until acknowledgement-aware retention is implemented and validated. When enabled, deletion work must be idempotent, retain pinned revisions, tolerate offline devices, and keep an orphan grace period for upload-before-commit failures.

## Privacy-safe support bundle

A future support export may contain:

- Meridian and protocol versions
- Obsidian and platform versions
- enabled sync categories
- cursor and queue counts
- sanitized error codes and timings

It must exclude vault names, file paths, content, ciphertext, keys, tokens, signatures, public key material, and recovery data.
