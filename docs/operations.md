# Operations

## Invariants

- Cloudflare never gets plaintext keys, paths, metadata, or file content.
- The Durable Object log is authoritative. WebSockets are hints.
- R2 stores immutable encrypted chunks used by committed revisions.
- A local cursor advances only after safe verification and apply.
- Concurrent content is merged or kept as an explicit conflict. It is never silently lost.

## Health and logs

`GET /health` shows deployment health and safe protocol metadata only. **Troubleshooting** shows technical status, storage details, repair tools, and a bounded privacy-safe session log. **Sync log** shows the latest 200 user-visible changes and may contain paths.

Use Workers Logs and Traces for request classes, latency, binding failures, cursor lag, reconnects, retries, and encrypted byte counts.

> **Never log** setup or session tokens, keys, recovery material, paths, envelope bodies, or stable IDs not needed for diagnosis.

The foreground plugin uses one exact deadline timer. Even with a healthy socket, it makes an authoritative HTTP check every five minutes. Socket reconnects use jittered exponential backoff. Failed HTTP polls use exponential backoff. Both cap at five minutes. The browser `online` event and app resume retry at once.

## Compatibility

Current clients write only canonical generation-1 logs and current epoch transitions. The Worker rejects writes to a non-canonical vault.

Migrated vaults keep immutable legacy-hash entries and their signed transition. Clients can verify and replay this history. They cannot add a legacy entry or another format transition.

> **Do not downgrade Meridian.** Downgrades are not supported.

## Replace a phone

1. On the owner, open **Devices and recovery → Add device** and pair the new phone.
2. Confirm that the new phone can pull and push.
3. Find the old phone by name, platform, short cryptographic ID, and authorization time.
4. Select **Revoke** and confirm that it shows **Revoked**.

Revocation blocks that identity's sessions and future writes at once. It does not delete local files. The identity stays in audit history and must pair again to sync.

## Pair the same member again

A configured vault rejects setup and pairing links. This prevents accidental identity replacement.

1. Sync important queued changes.
2. On the iPhone, select **Remove this device** and confirm the warning.
3. Meridian signs and confirms a self-revocation. It forgets the local key and connection, but keeps all vault files and journal records.
4. On the Mac owner, open **Devices and recovery → Add device** and scan a new QR code from that iPhone vault.

If pairing is canceled, select **Retry** on the Mac for a new code. If signed completion is interrupted, Meridian keeps the exact completion in SecretStorage and shows **Retry pairing**. Do not remove plugin data while this action is present.

**Pause** is temporary. It keeps the identity. **Remove this device** is permanent and for members only. An owner cannot remove itself. Use ownership recovery after owner loss.

## Incident response

### Lost device

1. On the owner, find the lost device and select **Revoke**.
2. Confirm that it shows **Revoked**.
3. Open **Troubleshooting** and check the encryption epoch.

Only the owner can revoke another device. Revocation appends a signed record and blocks that device's sessions and writes at once. The owner cannot revoke itself.

After the other active devices report epoch-transition support, the owner signs a new epoch. Only those devices get the new key.

For suspected owner compromise, recover on a trusted replacement. Recovery revokes all old devices and creates a recovery-signed epoch. Neither process can erase plaintext or old keys already held by a device.

### Lost all devices

1. Install Meridian on a replacement.
2. Select recovery and enter the Worker URL and offline recovery material.
3. Select **Recover and revoke devices**.
4. Let Meridian verify and decrypt the package locally.

The replacement becomes owner. Meridian revokes all old devices and sessions, rotates the epoch, and keeps old keys locally for history.

A server that controls the only recovery package can withhold it or show one no newer than your last independently kept checkpoint.

### Suspected server rollback

1. Stop writes.
2. From every available device, keep the local journal, highest trusted cursor, log hash, and signed checkpoints.
3. Compare checkpoints.

> Do not reset a device or overwrite local state first.

### Mass deletion or corruption

1. Pause sync on another device before opening it.
2. Open **History**. Inspect, compare, and restore the affected revisions.

Restores make new revisions. They do not rewrite the audit trail.

## Backup

> **Sync is not a backup.** Keep an independent plaintext backup and offline recovery material.

Worker code does not snapshot Durable Object SQLite or R2. R2 history protects revisions only while their chunks remain.

## Retention and storage

Meridian uses **Keep committed history forever**. It never automatically removes committed operations, revision metadata, referenced blobs, conflicts, checkpoints, snapshots, device or revocation history, or old epoch keys needed for history. A long-offline active device can replay from its signed cursor.

Log truncation and finite history are off. Current acknowledgements do not identify a complete archive that can safely start a device again.

Only disposable state is compacted:

- Completed local upload entries and exact duplicate history metadata are removed in crash-safe IndexedDB batches.
- Dirty events, pending or prepared retries, revision graph ancestry, unresolved conflicts, revocations, and checkpoints are never compacted.
- Expired pairing capabilities are removed in every terminal state.
- Only the current recovery exact-retry record is kept.
- Encrypted uploads older than seven days may be removed only when no committed revision or recent reservation protects them.

### Blob claims and fences

```text
reserve byte size in SQLite → stream to R2 → confirm in R2 → allow commit
```

Every upload follows this flow. A file operation cannot commit until every blob exists. Cleanup fences each candidate in SQLite before R2 deletion. Other requests stay responsive. Uploads and commits that touch a fence retry safely.

### Quotas

The storage view shows SQLite and R2 use, device acknowledgement progress, in-flight reservations, browser quota pressure, and whether persistence was granted.

Acknowledgements are signed status data over the exact cursor, hash, epoch, and forever policy. They never allow deletion.

Cloudflare limits and browser quotas are external hard limits. If IndexedDB is full, the transaction aborts. The cursor stays put. Pending work and vault files remain.

Open **Troubleshooting → Storage details** to compact local sync records, request persistent browser storage, or inspect remote use. Keep an independent backup.

## Privacy-safe support data

**Troubleshooting → Technical log** keeps only standard sync states and whether an error occurred. Raw errors never enter the log. The copied report includes versions, platform, enabled categories, cursor and queue counts, and safe state transitions.

It excludes vault names, paths, content, endpoints, device identifiers, ciphertext, keys, tokens, signatures, public keys, and recovery data. The separate user-facing sync log can show paths and must never be copied into a support report.
