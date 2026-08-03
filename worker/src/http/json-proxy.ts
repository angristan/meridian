import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { decodeJsonEffect, runHttpEffect } from "./effect-boundary"
import { extractSessionToken } from "./session"
import type { WorkerContext } from "./types"
import { callVaultEffect } from "./vault-proxy"

export function proxyJson<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  path: (c: WorkerContext) => string,
  options: { authenticated?: boolean; method?: "POST" | "PUT" } = {},
) {
  return (c: WorkerContext) =>
    runHttpEffect(
      Effect.gen(function* () {
        const body = yield* decodeJsonEffect(c.req.raw, schema)
        const token = options.authenticated ? extractSessionToken(c.req.raw) : undefined
        return yield* callVaultEffect(c.env, path(c), options.method ?? "POST", body, token)
      }),
    )
}
