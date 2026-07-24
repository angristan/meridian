import { Effect } from "effect"
import { constantTimeSecretEquals } from "../encoding"
import { HttpError } from "../errors"
import { SetupClaimSchema, SetupSessionRequestSchema } from "../schemas"
import { SECURITY_HEADERS, SETUP_PAGE, SETUP_SCRIPT } from "../setup-page"
import { decodeJsonEffect, runResponse } from "./effect-boundary"
import { proxyJson } from "./json-proxy"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

export function registerSetupRoutes(app: WorkerApp): void {
  app.use("*", async (c, next) => {
    await next()
    c.header("x-content-type-options", "nosniff")
    c.header("referrer-policy", "no-referrer")
    if (c.req.path.startsWith("/v1/")) c.header("cache-control", "no-store")
  })

  app.get("/health", (c) => c.json({ ok: true, service: "meridian-sync", protocol: 1 }))

  app.get("/setup", (c) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    return c.html(SETUP_PAGE)
  })

  app.get("/assets/setup.js", (c) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    c.header("content-type", "text/javascript; charset=utf-8")
    c.header("cache-control", "public, max-age=3600")
    return c.body(SETUP_SCRIPT)
  })

  app.get("/v1/setup/status", (c) => runResponse(callVaultEffect(c.env, "/internal/status", "GET")))

  app.post("/v1/setup/session", (c) =>
    runResponse(
      Effect.gen(function* () {
        const body = yield* decodeJsonEffect(c.req.raw, SetupSessionRequestSchema)
        const configuredToken = c.env.SETUP_TOKEN
        if (!configuredToken || configuredToken.length < 32) {
          return yield* Effect.fail(
            new HttpError(503, "setup_unavailable", "A high-entropy SETUP_TOKEN is not configured"),
          )
        }
        const matches = yield* Effect.tryPromise({
          try: () => constantTimeSecretEquals(body.token, configuredToken),
          catch: () => new HttpError(500, "setup_failed", "Setup token could not be verified"),
        })
        if (!matches) {
          return yield* Effect.fail(
            new HttpError(401, "invalid_setup_token", "Setup token is invalid"),
          )
        }
        return yield* callVaultEffect(c.env, "/internal/setup/session", "POST")
      }),
    ),
  )

  app.post(
    "/v1/setup/claim",
    proxyJson(SetupClaimSchema, () => "/v1/setup/claim"),
  )
}
