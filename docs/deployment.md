# Deployment

Meridian uses these Cloudflare resources:

```text
One Worker
  ├─ one SQLite Durable Object: VaultDurableObject
  └─ one private R2 bucket: meridian-blobs
```

The root is deployable because Deploy to Cloudflare does not fully resolve dependencies outside a selected monorepo directory.

## Before you deploy

Use a password manager to create a random, one-time `SETUP_TOKEN` of at least 32 bytes. Do not reuse a password. Never put the token in source control, logs, screenshots, or support messages.

## Deploy to Cloudflare

1. Open the **Deploy to Cloudflare** button in the main README.
2. Select the target Cloudflare account.
3. Choose the repository name.
4. Enter the `SETUP_TOKEN`.
5. Check the resources that Cloudflare will create:
   - Worker: `meridian`
   - Durable Object class: `VaultDurableObject`
   - R2 bucket: `meridian-blobs`
6. Deploy and copy the Worker URL.
7. Open `<worker-url>/setup` and enter the token.
8. Connect the first Obsidian device.

The first successful claim disables the setup token in application state forever.

## Run locally with Workerd

```bash
bun install
cp .dev.vars.example .dev.vars
# Replace SETUP_TOKEN in .dev.vars
bun run types
bun run dev
```

Wrangler keeps local Durable Object and R2 data in `.wrangler/`.

> **Warning:** Remove `.wrangler/` only when you want to reset a disposable local environment.

## Validate without deploying

```bash
bun install --frozen-lockfile
bun run check
bun run deploy:dry
```

The dry run bundles locally. It does not check remote permissions, bindings, routes, or data.

## Deploy to production

1. Authenticate Wrangler.
2. Confirm the target Cloudflare account.
3. Review `wrangler.jsonc`.
4. Review all Durable Object migrations.
5. Deploy:

   ```bash
   bun run deploy
   ```

> **Warning:** Deployment changes the remote service.

GitHub Actions checks every push and pull request. Cloudflare Workers Builds connects to the repository and deploys validated `main` commits with pinned Wrangler. Cloudflare owns the build credential, so GitHub stores no personal Cloudflare API token.

## Authentication and Cloudflare Access

Meridian devices use Meridian authentication for the sync API.

> **Do not put Cloudflare Access in front of `/v1/*`.** It would break unattended device requests.

If Meridian later has an admin UI, protect only its separate admin routes.

## Upgrade safely

- Ship the Hono RPC caller and `VaultDurableObject` in the same Worker version.
- For gradual deployment, keep RPC methods compatible between versions. Otherwise, route each request to one code version from start to finish.
- Deploy Durable Object migrations separately from unrelated high-risk changes.
- Remember that a Worker rollback does not roll back Durable Object SQLite or R2 data.
- Never remove or rename a Durable Object class without a reviewed migration and recovery plan.
- Keep every protocol generation that stored operations still use. Remove one only after every device and retained revision has migrated.

The Deploy to Cloudflare flow creates a repository in the owner's account. Pull upstream Meridian changes into that repository before you redeploy. Do not overwrite its local resource names or secrets.

## Reset a deployment

Meridian has no unauthenticated reset endpoint. This is intentional.

Resetting a claimed deployment can destroy sync state. It must be an explicit operator action. In-plugin ownership recovery revokes devices. It does not delete server data.

For development, reset only disposable vaults and local `.wrangler/` data.
