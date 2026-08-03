import { runHttpEffect } from "./effect-boundary"
import { extractSessionToken } from "./session"
import type { WorkerApp } from "./types"
import { vaultResponseEffect } from "./vault-proxy"

export function registerStorageRoutes(app: WorkerApp): void {
  app.get("/v1/storage", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.storageStats(token)))
  })

  app.post("/v1/storage/prune-orphans", (context) => {
    const token = extractSessionToken(context.req.raw)
    return runHttpEffect(vaultResponseEffect(context.env, (vault) => vault.pruneOrphanBlobs(token)))
  })
}
