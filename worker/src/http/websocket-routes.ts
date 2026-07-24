import { Effect } from "effect"
import { HttpError } from "../errors"
import { runResponse } from "./effect-boundary"
import { sessionToken, validateSessionEffect } from "./session"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

export function registerWebSocketRoutes(app: WorkerApp): void {
  app.get("/v1/notifications", (c) =>
    runResponse(
      Effect.gen(function* () {
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
          return yield* Effect.fail(
            new HttpError(426, "upgrade_required", "WebSocket upgrade required"),
          )
        }
        const token = sessionToken(c)
        yield* validateSessionEffect(c.env, token)
        return yield* callVaultEffect(
          c.env,
          "/v1/notifications",
          "GET",
          undefined,
          token,
          c.req.raw,
        )
      }),
    ),
  )
}
