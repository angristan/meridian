# Testing on devices

Use a disposable vault with representative Markdown, images, PDFs, folders, and settings. Keep an independent copy before every destructive or recovery scenario.

## macOS development installation

1. Create and open a new empty Obsidian vault.
2. Build and install Meridian:

   ```bash
   bun install
   bun run plugin:install -- --vault /absolute/path/to/test-vault
   ```

3. In Obsidian, open **Settings → Community plugins**, turn off Restricted Mode, and enable **Meridian Sync**.
4. Start the local Worker with `bun run dev`, or enter a deployed Worker URL.
5. Complete setup and save the recovery code outside the test vault.
6. Reload Obsidian after each development rebuild, or use the Obsidian developer workflow of your choice.

The installer refuses paths without a `.obsidian` directory and writes only `.obsidian/plugins/meridian-sync/`.

## iPhone beta installation

The recommended unpublished-plugin path is BRAT:

1. Publish a GitHub Release containing `main.js`, `manifest.json`, and `styles.css`.
2. Install **BRAT** from Obsidian Community Plugins on the iPhone.
3. Add `angristan/meridian` as a beta plugin.
4. Enable **Meridian Sync**.
5. Pair the iPhone from the Mac using the one-time deep link and verify the authentication phrase on both devices.

Until the repository and a release are public, the build produces `obsidian-plugin/dist/meridian-sync.zip` for manual inspection, but BRAT is the reliable mobile installation channel. Publishing a repository or release is an external write and is not performed by the local build.

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

### Security lifecycle

- Pair a second device and verify the authentication phrase.
- Verify the device registry and that invalid or expired pairing capabilities are rejected.
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
