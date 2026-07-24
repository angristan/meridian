# Deployment

Meridian uses one Worker deployment, one SQLite-backed Durable Object class, and one private R2 bucket. The repository root is intentionally deployable because Deploy to Cloudflare buttons do not fully resolve dependencies outside a selected monorepo subdirectory.

## Deploy to Cloudflare

1. Open the Deploy to Cloudflare button in the README.
2. Select the target Cloudflare account and repository name.
3. Enter a random one-time `SETUP_TOKEN` of at least 32 bytes. Generate it with a password manager; do not reuse a password.
4. Review the automatically provisioned resources:
   - Worker: `meridian-sync`
   - Durable Object class: `VaultDurableObject`
   - R2 bucket: `meridian-blobs`
5. Deploy and copy the resulting Worker URL.
6. Visit `<worker-url>/setup` and enter the setup token.
7. Connect the first Obsidian device. A successful claim permanently disables the setup token in application state.

Do not place the token in source control, application logs, screenshots, or support messages.

## Local Workerd environment

```bash
bun install
cp .dev.vars.example .dev.vars
# Replace SETUP_TOKEN in .dev.vars
bun run types
bun run dev
```

Wrangler persists local Durable Object and R2 data under `.wrangler/`. Remove that directory only when deliberately resetting the disposable local environment.

## Validate without deploying

```bash
bun install --frozen-lockfile
bun run check
```

`bun run deploy:dry` validates and bundles locally. It does not verify remote account permissions, bindings, routes, or data.

## Production deployment

After authenticating Wrangler and confirming the target account:

```bash
bun run deploy
```

Deployment is a remote mutation. Review `wrangler.jsonc`, the target account, and any Durable Object migrations first.

GitHub Actions validates every push and pull request. Cloudflare Workers Builds is connected directly to the private repository and deploys validated `main` commits with the pinned Wrangler configuration. Cloudflare owns the build credential, so the GitHub repository does not store a personal Cloudflare API token.

The sync API uses Meridian device authentication rather than Cloudflare Access. Placing Access in front of `/v1/*` would break unattended device requests. If an administrative UI is added, protect only its dedicated routes.

## Upgrades

- Keep Worker endpoints and Durable Object RPC forward/backward compatible during deployment skew.
- Deploy Durable Object migrations separately from unrelated high-risk changes.
- A Worker rollback does not roll back Durable Object SQLite or R2 data.
- Never remove or rename a Durable Object class without a reviewed migration and recovery plan.
- Preserve protocol generations already referenced by stored operations until every device and retained revision has migrated.

The Deploy to Cloudflare flow creates a repository in the owner's account. Pull upstream Meridian changes into that repository before redeploying; do not overwrite local resource names or secrets.

## Resetting a deployment

There is intentionally no unauthenticated reset endpoint. Resetting a claimed deployment can destroy synchronization state and must be an explicit operator action. The in-plugin ownership recovery flow revokes devices but intentionally does not delete server data. For development, reset only local `.wrangler/` data and disposable vaults.
