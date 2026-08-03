# Meridian

Meridian syncs one Obsidian vault across macOS and iPhone. You host it in Cloudflare. Notes, attachments, paths, metadata, and selected settings are encrypted before upload.

> [!WARNING]
> Meridian is pre-release software. Use a disposable vault. Keep a separate backup. Do not use Meridian with Obsidian Sync, iCloud Drive, Dropbox, or another vault sync system.

## What you get

- Local-first sync for Markdown files and attachments
- Immutable file history with infinite retention and safe compaction
- Offline edits, resumable catch-up, and deterministic conflict preservation
- Device pairing, revocation, recovery, and signed key epochs
- WebSocket hints with reliable HTTP polling
- Mobile code without Node.js or Electron APIs

Meridian is not a backup. It does not support live group editing, cross-vault sharing, server-side plaintext work, or continuous iOS background work.

## How it works

```text
Obsidian on Mac or iPhone
          |
          | HTTPS and WebSocket
          v
Cloudflare Worker
          |-- one SQLite Vault Durable Object
          |     authorization, encrypted log, cursors, checkpoints
          `-- private R2 bucket
                immutable encrypted chunks
```

The Durable Object is the ordered remote metadata authority. WebSockets only give hints. Authenticated HTTP catch-up is authoritative.

Cloudflare can see ciphertext sizes, request times, public authorization data, and device activity. It cannot see vault keys, content, paths, or revision metadata in plaintext.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/angristan/meridian)

1. Create a random one-time `SETUP_TOKEN` of at least 32 bytes.
2. Enter it in the deployment form.
3. Let Cloudflare create the Worker, Durable Object namespace, and private R2 bucket.
4. Open `/setup` on the deployed Worker. Enter the same token.
5. Install the Meridian plugin. Use **Open in Obsidian**, or paste the connection details.
6. Save the recovery code outside the vault before the first upload.

The first successful claim permanently disables setup authentication.

See [Deployment](docs/deployment.md) for local deployment, upgrades, and troubleshooting.

## Test on devices

Use a disposable vault on macOS:

```bash
bun install
cp .dev.vars.example .dev.vars
# Set SETUP_TOKEN in .dev.vars
bun run plugin:install -- --vault /path/to/disposable-vault
bun run dev
```

In Obsidian, disable Restricted Mode. Enable **Meridian**. Connect it to the Worker.

On iPhone, install a GitHub Release with [BRAT](https://github.com/TfTHacker/obsidian42-brat). Each release has `main.js`, `manifest.json`, `styles.css`, and `meridian.zip`. See [Testing on devices](docs/testing.md).

Obsidian plugins cannot run continuously in the iOS background. Meridian syncs when Obsidian opens or resumes. Sync does not depend on WebSockets.

## Develop

You need Bun 1.3.9 and an Obsidian test vault. Remote deployment also needs a Cloudflare account. Local Workerd tests do not need one.

```bash
bun install
bun run types
bun run check
```

Useful commands:

```bash
bun run dev             # start the local Worker and bindings
bun run plugin:build    # build Obsidian release files
bun run test            # run all workspace tests
bun run deploy:dry      # validate a deployment build
bun run format          # format the workspace
```

Use conventional commits. Semantic Release creates tags without a `v` prefix and publishes complete Obsidian release files after validation.

## Documentation

- [Architecture](docs/architecture.md)
- [Scope and decisions](PLAN.md)
- [Protocol](docs/protocol.md)
- [Threat model](docs/threat-model.md)
- [Deployment](docs/deployment.md)
- [Device testing](docs/testing.md)
- [Operations](docs/operations.md)

## Security limits

Meridian cannot protect plaintext on a compromised device. A malicious Obsidian plugin can read vault content and local secrets. Meridian uses standard cryptographic methods and extensive protocol tests.

## License

[MIT](LICENSE)
