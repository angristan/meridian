import { Hono } from "hono"
import { errorResponse, HttpError } from "./errors"
import { registerApiRoutes } from "./http/api-routes"
import { registerBlobRoutes } from "./http/blob-routes"
import { registerSetupRoutes } from "./http/setup-routes"
import { registerStorageRoutes } from "./http/storage-routes"
import type { WorkerBindings } from "./http/types"
import { registerWebSocketRoutes } from "./http/websocket-routes"
import { VaultDurableObject } from "./vault-do"

const app = new Hono<WorkerBindings>()

registerSetupRoutes(app)
registerApiRoutes(app)
registerBlobRoutes(app)
registerStorageRoutes(app)
registerWebSocketRoutes(app)

app.notFound(() => errorResponse(new HttpError(404, "not_found", "Route not found")))
app.onError((error) => errorResponse(error))

export type { WorkerEnv } from "./http/types"
export { VaultDurableObject }
export default app
