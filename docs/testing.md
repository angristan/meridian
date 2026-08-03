# Testing on devices

> **Use a disposable vault.** Add Markdown, images, PDFs, folders, and settings. Keep an independent copy before destructive or recovery tests.

## macOS setup

1. Create and open an empty Obsidian vault.
2. Install Meridian:

   ```bash
   bun install
   bun run plugin:install -- --vault /absolute/path/to/test-vault
   ```

3. In **Settings → Community plugins**, turn off Restricted Mode and enable **Meridian**.
4. Run `bun run dev`, or enter a deployed Worker URL.
5. Finish setup. Save the recovery code outside the vault.
6. Reload Obsidian after each build, or use your normal developer workflow.

The installer needs a `.obsidian` directory. It writes only to `.obsidian/plugins/meridian/`.

## iPhone setup with BRAT

1. Publish a GitHub Release with `main.js`, `manifest.json`, and `styles.css`.
2. On the iPhone, install **BRAT** from Community Plugins.
3. Add `angristan/meridian` as a beta plugin. Enable **Meridian**.
4. On the Mac, create a five-minute QR code in **Meridian status → Devices and recovery**.
5. Scan it on the iPhone.
6. On the Mac, check the signed name, platform, and short ID.
7. Compare the automatic phrase on both devices. Repeated items are valid.
8. Select **Phrases match** on both devices.
9. Check that the QR disappears after the request. Both dialogs must close after signed completion. The iPhone must sync and appear by name on the Mac.

Do not transfer candidate packages or pairing IDs by hand.

The build also makes `obsidian-plugin/dist/meridian.zip` for review. BRAT is the reliable mobile installation method.

## Manual checks

### Basic sync

- [ ] On each device, create, edit, rename, move, and delete Markdown.
- [ ] Add images, PDFs, and a representative large attachment.
- [ ] Make changes while each device is offline. Both devices must later converge.

### Conflicts

- [ ] Edit different lines offline; expect a deterministic merge.
- [ ] Edit the same line; expect an explicit conflict.
- [ ] Edit and delete the same file; expect a recovered conflict, not loss.
- [ ] Rename on one branch while editing on the other.

### Reliability

- [ ] Suspend Obsidian during upload and download.
- [ ] Switch between Wi-Fi and mobile data.
- [ ] Force-quit and reopen Obsidian.
- [ ] Keep a device offline across many operations.
- [ ] Disable WebSockets. HTTP polling must catch up from the saved cursor.

## Deterministic fault tests

```bash
bun run fault:test
bun run fault:test --seed 12345
bun run fault:test:long
bun run fault:test:plugin
bun run fault:test:worker
```

The root command prints its seed. `--seed` replays the same faults, actions, and restarts. The long command runs 50 derived seeds with 20 stateful steps each. Override these with `--seeds` and `--steps`.

Promise barriers and injected failures replace timing sleeps. Tests cover:

- index repair racing active reconciliation;
- blob pruning racing a commit before and after the R2 metadata check;
- a lost success response, then restart from the same IndexedDB database;
- repeated edit or delete actions through every commit fault in a shuffled, deterministic deck;
- database reopen, convergence, and a final no-op sync.

Failures write:

```text
.fault-traces/plugin-seed-<seed>-steps-<steps>.json
```

The trace has stable actions, faults, checkpoints, and invariant results. Rerun the printed command. Keep the smallest failure as a regression test.

Tests must prove that committed revisions keep blobs, repair keeps planned deletions, and exact response-loss retries keep one cursor and hash while draining pending work.

Worker boundary tests call typed Durable Object methods directly. Normal internal `fetch()` paths must return 404. Remote-call errors must keep the public status, code, and message. Hono must reject malformed or oversized JSON. Blob cleanup races must stay safe through these calls.

## Responsiveness and index recovery

- [ ] Add 10,000 small files, then edit one. Sync scans only that path. Snapshots use the hydrated journal index, not another IndexedDB `getAll()`.
- [ ] Reconcile 10,000 unchanged files. Reuse cached fingerprints without reading content or planning all renames.
- [ ] Change a file while Meridian is stopped or Obsidian is suspended. Resume detects changed size or modification time.
- [ ] Change bytes but keep size and time. The daily full fingerprint audit detects it.
- [ ] Rename a file. Old and new dirty paths keep one stable file ID.
- [ ] Edit again during commit. The newer dirty token stays queued.
- [ ] Apply a remote revision. Its Obsidian event causes no duplicate revision.
- [ ] Pause a large scan. Planning stops, no partial reconciliation commits, and dirty paths remain. Unload stops any hash Worker.
- [ ] Test an 8 MiB hash with Blob Workers available and unavailable.
- [ ] Test a cooperative 10,000-file index and 500-operation pull batch.
- [ ] Allow at most four active chunk transfers. Keep chunk order. Never commit after a failed chunk.
- [ ] One exact timer combines scan and poll deadlines. New installs use a 45-second disconnected poll, five-minute full scan, and 64 MiB file limit. Faster or larger legacy settings never become slower or less capable. Reconnect backoff caps at five minutes.

Automated tests use generous time limits to find pathological regressions. They check that fallbacks and batch pulls yield to timer heartbeats. They are not hardware performance claims.

## History and recovery state checks

- [ ] Open global History with more than 200 revisions. Show every revision. Keep the Sync log bounded to the latest 200 changes.
- [ ] Open per-file history from the command palette and file menu. Preview, compare, and restore without rewriting old revisions.
- [ ] Recover deleted files and resolve conflicts from their focused views. Keep both visible from Meridian status.
- [ ] Replay `legacy revision → signed format transition → canonical revision` from cursor zero.
- [ ] Resume before and after the transition; select the correct hash format.
- [ ] Backfill all history across it without rewriting entries.
- [ ] Reject a new transition and appends to a non-canonical vault.
- [ ] Alter, omit, reorder, or fork canonical or legacy history. Reject it before decrypting or changing the vault.
- [ ] Send two recovery claims from one predecessor; exactly one replaces the package.
- [ ] Retry the winner exactly; return the same result without another replacement.
- [ ] Reject an older-format or stale claim without consuming newer state.

## Epoch rotation

- [ ] Reject a transition with a missing, extra, or duplicate active-device recipient.
- [ ] Commit for the exact active set; all devices reach the same next sequence.
- [ ] Lose the response, fail SecretStorage replacement, and crash before checkpoint advance. Retry exactly. Never move the cursor past an unreadable key.
- [ ] Prepare a revision under the old epoch, then receive a transition. Keep exact plaintext and rebuild ciphertext under the next epoch.
- [ ] Revoke a member. Exclude it from the next set. Rotate the others automatically.
- [ ] Race rotation with a revision, second rotation, recovery, and pairing completion. Only one update from the same old state wins.
- [ ] Read every old epoch. Reject missing, duplicate, replaced, or undecryptable recipient packages.
- [ ] Recover from a version-2 package. Before writing, verify authorization, any transition, checkpoint, keyring, and recovery state match.
- [ ] After activation, an old client shows **Update Meridian to continue** and appends nothing.

## Retention and storage

- [ ] Leave one active device offline. Keep all operations, blobs, epoch keys, and history. Show its lag in acknowledgements.
- [ ] Reject an acknowledgement with a wrong signature, device, cursor or hash, stale epoch, or lower cursor. Never move retention backward.
- [ ] Lose responses before R2 `PUT`, after it, and before Durable Object confirmation. Exact retry reconciles the immutable object and claim without duplicate catalog entries.
- [ ] Reject an operation with a missing R2 chunk before advancing the cursor.
- [ ] Run orphan cleanup during and after an interrupted upload. Keep recent claims. Remove old unreferenced objects idempotently.
- [ ] Pause cleanup after its SQL fence, then commit that blob. The commit retries. No missing-blob operation appears.
- [ ] Pause commit after its provisional SQL claim but before R2 `HEAD`. Cleanup keeps the blob; commit succeeds.
- [ ] Fail R2 deletion after fencing. Clear the fence; exact cleanup retry succeeds.
- [ ] Stop after R2 deletion but before SQL cleanup. The next upload atomically recovers the fence.
- [ ] Fail the operation transaction after blob confirmation. No operation appears. The blob stays reserved. Exact retry commits once.
- [ ] After server commit, stop after pushed-revision settlement and after checkpoint persistence. Reopen the same database at each point. Keep one revision copy, drain pending work, and never pass missing local state.
- [ ] Stop after remote apply and after history revision/checkpoint transactions. Reopen the database. Replay is idempotent and the live checkpoint stays last.
- [ ] Recreate legacy crashes after snapshot and revision persistence. Restart and append a remote descendant. Avoid a false conflict or stale snapshot overwrite.
- [ ] Fill IndexedDB. Inject quota errors in entry, applied-operation, history, and checkpoint transactions. Abort transactions, keep exact prepared work, and do not advance the cursor.
- [ ] Crash between compaction batches. Reopen and rerun. Remove only completed entries and duplicate history. Keep pending work, dirty tokens, revision graph parents, tombstones, conflicts, checkpoints, revocations, and old-epoch history.
- [ ] On mobile, test missing `navigator.storage`, warnings at 80%, critical pressure at 90%, and user-gesture persistence requests.

## Security lifecycle

- [ ] Pair a second device from **Devices and recovery**. Check the automatic phrase on both screens.
- [ ] Block encrypted transfer until both confirmations. Cancellation authorizes nobody. Completion updates both screens. Reject invalid or expired capabilities.
- [ ] Drop responses after join, owner approval, release, and signed completion. Keep and replay exact SecretStorage data. Closing after phrase confirmation does not cancel. Canceled screens offer a new-code retry. Insert a completed device once.
- [ ] As owner, revoke an older member by short ID. Its sessions fail at once and its row shows **Revoked**. A member never sees an active **Add device** action. Other clients apply the signed revocation without revision decryption.
- [ ] As member, select **Remove this device**. Warn about queued changes, keep files, self-revoke, forget local keys and config, and allow pairing again.
- [ ] Reject owner self-removal and member cross-device revocation. Lose a revocation response and restart at every cleanup boundary. Only exact `device_not_found` confirmation finishes cleanup.
- [ ] Scan setup and pairing links in connected, paused, partly configured, and removal-pending vaults. Stop before key creation or identity change.
- [ ] Pair a replacement before revoking the old phone. Keep one working device and revoke only the old identity.
- [ ] Recover in a fresh disposable vault. Revoke all old sessions. New writes use the rotated epoch.
- [ ] Reject stale cursors, duplicate operations, changed chunk order, and modified ciphertext safely.

## Product settings and troubleshooting

- [ ] Normal settings show only Connection, Devices and recovery, Obsidian configuration, and Troubleshooting.
- [ ] No selective-sync, polling, scan-interval, file-limit, encryption-epoch, storage, pruning, recovery, or repair control appears at the top level.
- [ ] Saved selective-sync rules block startup and remain available to Meridian 1.11.13 for a safe downgrade and final sync.
- [ ] Technical logs and copied reports exclude paths, endpoints, device identifiers, raw errors, secrets, and recovery data.
- [ ] Sync log entries may show paths but never enter copied support data.

Test each configuration category on every device:

- [ ] Main settings
- [ ] Appearance
- [ ] Themes and snippets
- [ ] Hotkeys
- [ ] Active core plugin list
- [ ] Core plugin settings

Workspace and layout state, Meridian state, caches, and secret storage stay device-local.

## iOS

Obsidian suspends community plugins in the background. Meridian tries to flush durable file events when hidden. It promises foreground and resume sync, not continuous background delivery.

> After reopening Obsidian, check status before assuming another device got a change.
