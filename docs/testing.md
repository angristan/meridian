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

- Populate 10,000 small files, edit one file, and verify routine sync scans only that path.
- Change a file while Meridian is stopped or Obsidian is suspended; verify resume performs a complete scan and catches it.
- Rename a file and verify the paired old/new dirty paths preserve one stable file identity.
- Edit a path again while reconciliation is committing; verify the newer dirty token remains queued.
- Apply a remote revision and verify its resulting Obsidian event does not echo a duplicate revision.
- Pause during a large scan; the Worker must terminate, no partial reconciliation may commit, and dirty paths must remain.
- Test an 8 MiB chunk, a 10,000-file index, and a 500-operation pull batch with the Worker enabled and with Blob Workers unavailable.

Automated responsiveness tests use generous wall-clock ceilings to detect pathological regressions and assert that cooperative fallbacks and batch pulls yield to timer heartbeats. They are not hardware performance claims.

### Protocol migration and recovery CAS

- Open an existing legacy vault with the new client; verify normal legacy sync still works before upgrade.
- Upgrade from the owner settings. Verify the transition is legacy-hashed, the next operation is canonical-hashed, and old history is unchanged.
- Lose the upgrade response and restart before and after pull; verify the exact transition retries and the setting reaches **Upgraded**.
- Write from another device between preparation and commit; verify the stale transition fails and can be prepared again.
- Try an old client after upgrade; it must stop with **Update Meridian to continue** and append nothing.
- Alter, omit, reorder, or fork a canonical log entry; reject it before decrypting or changing the vault.
- Submit two recovery claims from the same predecessor; exactly one may replace the package.
- Retry the successful recovery request exactly; return the same result without a second replacement.
- Submit a legacy or stale recovery claim; reject it without consuming valid newer state.

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

Obsidian suspends community plugins in the background. Meridian therefore promises foreground and resume synchronization, not continuous background delivery. Always check status after reopening Obsidian before assuming the remote device has received a change.
