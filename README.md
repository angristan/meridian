# Meridian

Meridian is a self-hosted, end-to-end encrypted synchronization system for Obsidian. It keeps one vault synchronized across macOS and iOS using a Worker, one SQLite-backed Durable Object, and a private R2 bucket in your own Cloudflare account.

> [!WARNING]
> Meridian is pre-release software. Use a disposable vault and keep an independent backup. Do not run it alongside Obsidian Sync, iCloud Drive, Dropbox, or another vault sync engine.

## What it provides

- Local-first Markdown and attachment synchronization
- End-to-end encryption before bytes leave Obsidian
- Immutable per-file revision history with infinite retention and safe compaction
- Offline edits with resumable cursor-based catch-up
- Device pairing, revocation, recovery, and signed key epochs
- Hibernating WebSocket notifications with polling fallback
- Selected Obsidian settings synchronization
- One-click Cloudflare resource provisioning
- Mobile-compatible plugin code without Node.js or Electron APIs

## Architecture

```text
Obsidian on Mac / iPhone
        |
        | HTTPS + WebSocket
        v
Cloudflare Worker
        |
        |-- one Vault Durable Object
        |     device authorization, encrypted log, cursors, checkpoints
        |
        `-- private R2 bucket
              immutable encrypted file chunks
```

Cloudflare sees ciphertext sizes, timing, and device activity, but does not receive plaintext vault keys, file contents, paths, or revision metadata.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/angristan/meridian)

1. Choose a high-entropy one-time `SETUP_TOKEN` in the deployment form.
2. Let Cloudflare provision the Worker, Durable Object namespace, and R2 bucket.
3. Open the deployed Worker URL at `/setup` and enter the same token.
4. Install and enable the Meridian Obsidian plugin.
5. Use the setup page's **Open in Obsidian** link or paste the connection details into the plugin.
6. Save the recovery code outside the vault before starting the first upload.

The first successful claim permanently disables bootstrap authentication for that deployment.

See [Deployment](docs/deployment.md) for local deployment, upgrades, and troubleshooting.

## Test the plugin on macOS

Use a disposable Obsidian vault:

```bash
bun install
cp .dev.vars.example .dev.vars
# Set SETUP_TOKEN in .dev.vars
bun run plugin:install -- --vault /path/to/disposable-vault
bun run dev
```

In Obsidian, disable Restricted Mode, enable **Meridian**, and connect it to the local or deployed Worker.

## Test on iPhone

The normal beta channel is a GitHub Release installed through [BRAT](https://github.com/TfTHacker/obsidian42-brat). The release workflow produces `main.js`, `manifest.json`, `styles.css`, and `meridian.zip` for every release. See [Testing on devices](docs/testing.md) for the complete mobile flow.

Obsidian community plugins cannot run continuously in the iOS background. Meridian synchronizes immediately when Obsidian opens or resumes and never relies on the WebSocket for correctness.

## Development

Requirements:

- Bun 1.3.9
- An Obsidian test vault
- A Cloudflare account only for remote deployment; local Workerd tests require none

```bash
bun install
bun run types
bun run check
```

Useful commands:

```bash
bun run dev             # local Worker and bindings
bun run plugin:build    # Obsidian release artifacts
bun run test            # all workspace tests
bun run deploy:dry      # bundle and validate without deploying
bun run format          # format the workspace
```

The project uses conventional commits. Semantic Release creates Obsidian-compatible tags without a `v` prefix and publishes complete GitHub Release assets after validation.

## Documentation

- [Architecture](docs/architecture.md)
- [Scope and decision index](PLAN.md)
- [Protocol](docs/protocol.md)
- [Threat model](docs/threat-model.md)
- [Deployment](docs/deployment.md)
- [Device testing](docs/testing.md)
- [Operations](docs/operations.md)

## Security boundaries

Meridian uses standard cryptographic primitives and extensive protocol tests, but it cannot protect plaintext on a compromised device. Any malicious Obsidian plugin running in the same app can potentially access vault content and locally available secrets. Synchronization is also not a backup.

## License

[MIT](LICENSE)
