# Testing on devices

Use a disposable vault with representative Markdown, images, PDFs, folders, and settings. Keep an independent copy before every destructive or recovery scenario.

## macOS development installation

1. Create and open a new empty Obsidian vault.
2. Build and install Meridian:

   ```bash
   bun install
   bun run plugin:install -- --vault /absolute/path/to/test-vault
   ```

3. In Obsidian, open **Settings → Community plugins**, turn off Restricted Mode, and enable **Meridian**.
4. Start the local Worker with `bun run dev`, or enter a deployed Worker URL.
5. Complete setup and save the recovery code outside the test vault.
6. Reload Obsidian after each development rebuild, or use the Obsidian developer workflow of your choice.

The installer refuses paths without a `.obsidian` directory and writes only `.obsidian/plugins/meridian/`.

## iPhone beta installation

The recommended unpublished-plugin path is BRAT:

1. Publish a GitHub Release containing `main.js`, `manifest.json`, and `styles.css`.
2. Install **BRAT** from Obsidian Community Plugins on the iPhone.
3. Add `angristan/meridian` as a beta plugin.
4. Enable **Meridian**.
5. On the Mac, create a five-minute pairing QR code from **Meridian status → Devices**.
6. Scan it with the iPhone. On the Mac, review the signed device name, platform, and short ID, then continue to verification.
7. Compare the phrase automatically shown on both devices and tap **Phrases match** on each. Repeated phrase items are valid.
8. Confirm that the QR disappears after the request, both modals close after the signed completion acknowledgement, the iPhone starts syncing, and the named iPhone appears in the Mac device registry. Candidate packages and pairing IDs never need manual transfer.

Until the repository and a release are public, the build produces `obsidian-plugin/dist/meridian.zip` for manual inspection, but BRAT is the reliable mobile installation channel. Publishing a repository or release is an external write and is not performed by the local build.

## Required scenarios

### Basic synchronization

- Create, edit, rename, move, and delete a Markdown file on each device.
- Add images, PDFs, and a representative large attachment.
- Confirm both devices converge after each device has been offline.

### Conflicts

- Edit different lines of one note while both devices are offline; expect a deterministic merge.
- Edit the same line; expect explicit conflict preservation.
- Edit and delete the same file concurrently; expect a recovered conflict rather than data loss.
- Rename one branch while editing another.

### Reliability

- Suspend Obsidian during upload and download.
- Switch between Wi-Fi and cellular.
- Force-quit and reopen Obsidian.
- Leave a device offline across many operations.
- Disable WebSockets and verify polling catches up from the persisted cursor.

### Responsiveness and index recovery

- Populate 10,000 small files, edit one file, and verify routine sync scans only that path while snapshots come from the journal's hydrated index instead of another IndexedDB `getAll()`.
- Reconcile an unchanged 10,000-file vault; reuse every cached fingerprint without reading file contents or running full rename planning.
- Change a file while Meridian is stopped or Obsidian is suspended; verify resume detects changed size or modification time.
- Preserve both size and modification time while changing bytes; verify the daily complete fingerprint audit catches it.
- Rename a file and verify the paired old/new dirty paths preserve one stable file identity.
- Edit a path again while reconciliation is committing; verify the newer dirty token remains queued.
- Apply a remote revision and verify its resulting Obsidian event does not echo a duplicate revision.
- Pause during a large scan; the Worker must terminate, no partial reconciliation may commit, and dirty paths must remain.
- Test an 8 MiB chunk, a 10,000-file index, and a 500-operation pull batch with the Worker enabled and with Blob Workers unavailable.
- Verify uploads and downloads never exceed four active chunk transfers, preserve chunk order, and never commit a revision after a failed chunk.
- Verify one exact scheduler timer coalesces simultaneous scan/poll deadlines, reconnect backoff caps at five minutes, and suspension drains durable file-event writes.

Automated responsiveness tests use generous wall-clock ceilings to detect pathological regressions and assert that cooperative fallbacks and batch pulls yield to timer heartbeats. They are not hardware performance claims.

### Historical log verification and recovery CAS

- Replay an immutable `legacy revision → signed format transition → canonical revision` sequence from cursor zero.
- Resume from checkpoints before and after the historical transition; verify the correct hash format is selected.
- Backfill complete history across the transition without rewriting any entry.
- Reject attempts to submit a new format transition or append to a non-canonical vault.
- Alter, omit, reorder, or fork a canonical or legacy history entry; reject it before decrypting or changing the vault.
- Submit two recovery claims from the same predecessor; exactly one may replace the package.
- Retry the successful recovery request exactly; return the same result without a second replacement.
- Submit an older-format or stale recovery claim; reject it without consuming valid newer state.

### Epoch rotation

- Prepare a transition with a missing, extra, or duplicate active-device recipient; verify the Worker rejects it.
- Commit a transition for the exact active-device set; verify every device reaches the same successor sequence.
- Lose the commit response, fail SecretStorage replacement, and crash before IndexedDB checkpoint advancement; verify the exact transition retries and the cursor never passes an unreadable key.
- Prepare a revision under the predecessor epoch, then receive a transition; verify exact plaintext is retained and ciphertext is regenerated under the successor.
- Revoke one member; verify the next recipient set excludes it and the remaining devices rotate automatically.
- Race rotation with a revision, second rotation, recovery, and pairing completion; exactly one predecessor CAS may win.
- Read revisions from every retained old epoch and reject a missing, duplicate, substituted, or undecryptable recipient package.
- Recover from a version-2 package; verify device authorization, any required transition, checkpoint, keyring, and recovery CAS before writing.
- Try a client without epoch support after activation; it must receive **Update Meridian to continue** and append nothing.

### Retention and storage safety

- Leave one active device offline while another advances; verify all operations, referenced blobs, epoch keys, and history remain available and acknowledgement status shows the lagging device.
- Submit an acknowledgement with a wrong signature, device, cursor/hash, stale epoch, or lower cursor; verify the Worker rejects it and no retention state moves backward.
- Lose responses before R2 PUT, after R2 PUT, and before Durable Object confirmation; exact retry must reconcile the immutable object and upload claim without duplicating catalog entries.
- Commit an operation whose chunk is absent from R2; it must fail before the authoritative cursor advances.
- Run orphan cleanup during upload and after interrupted upload; recent claims survive, while old unreferenced objects are removed idempotently.
- Fill IndexedDB and inject quota errors at entry, revision, conflict, and checkpoint writes; transactions abort, prepared work remains exact, and the cursor never passes unavailable local state.
- Crash between local compaction batches; reopening and rerunning removes only completed entries and exact duplicate history rows. Pending work, dirty tokens, DAG parents, tombstones, conflicts, checkpoints, revocations, and old-epoch history remain usable.
- Test missing `navigator.storage` APIs on mobile, warning at 80%, critical pressure at 90%, and user-gesture persistent-storage requests.

### Security lifecycle

- Pair a second device and verify the automatically displayed phrase on both screens.
- Verify that the encrypted transfer stays unavailable until both confirmations, cancellation authorizes no device, completion updates both screens, and invalid or expired capabilities are rejected.
- Drop responses after join, owner approval, release, and signed completion. Verify exact SecretStorage material is retained and replayed, closing either modal after phrase confirmation does not cancel, canceled screens offer a fresh-code retry, and a completed device is inserted only once.
- From the owner, revoke the older member by its short ID. Verify its sessions fail immediately, the row becomes **Revoked**, the signed revocation advances other clients without revision decryption, and later operations from that identity are rejected.
- On a member, choose **Remove this device**. Verify queued changes are warned about, files remain, the member self-revocation succeeds, local keys/configuration are forgotten, and the same local vault can pair again.
- Verify owner self-removal and member cross-device revocation are rejected. Simulate a lost revocation response and restart at every cleanup boundary; only exact `device_not_found` confirmation may complete cleanup.
- Scan setup and pairing links in connected, paused, partially configured, and removal-pending vaults; each must stop before generating keys or changing identity.
- Pair a replacement phone before revoking the old phone; verify there is always at least one working device and only the intended old identity is revoked.
- Recover from the saved recovery material in a fresh disposable vault; verify all previous sessions are revoked and new writes use the rotated epoch.
- Present stale cursors, duplicate operations, changed chunk order, and tampered ciphertext; all must fail safely.

### Settings

Test each category independently on every device:

- Main settings
- Appearance
- Themes and snippets
- Hotkeys
- Active core plugin list
- Core plugin settings

Workspace/layout state, Meridian state, caches, and secret storage must remain device-local.

## iOS expectations

Obsidian suspends community plugins in the background. Meridian makes a best-effort flush of pending durable file events when the app becomes hidden, but promises foreground and resume synchronization rather than continuous background delivery. Always check status after reopening Obsidian before assuming the remote device received a change.
