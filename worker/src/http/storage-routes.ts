import { runHttpEffect } from "./effect-boundary"
import { authenticatedVaultEffect } from "./session"
import type { WorkerApp } from "./types"

export function registerStorageRoutes(app: WorkerApp): void {
  app.get("/v1/storage", (context) =>
    runHttpEffect(authenticatedVaultEffect(context, "/v1/storage")),
  )

  app.post("/v1/storage/prune-orphans", (context) =>
    runHttpEffect(authenticatedVaultEffect(context, "/v1/storage/prune-orphans", "POST")),
  )
}
