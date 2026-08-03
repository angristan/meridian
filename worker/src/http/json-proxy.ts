import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type { VaultReply, VaultRpcCall } from "../vault/rpc"
import { decodeJsonEffect, runHttpEffect } from "./effect-boundary"
import { extractSessionToken } from "./session"
import type { WorkerContext } from "./types"
import { callVaultEffect, type VaultStub, vaultReplyResponse } from "./vault-proxy"

export function proxyJson<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  call: (
    vault: VaultStub,
    input: S["Type"],
    context: WorkerContext,
  ) => VaultRpcCall<VaultReply<unknown>>,
) {
  return jsonHandler(schema, (vault, input, context) => call(vault, input, context))
}

export function proxyAuthenticatedJson<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  call: (
    vault: VaultStub,
    input: S["Type"],
    sessionToken: string,
    context: WorkerContext,
  ) => VaultRpcCall<VaultReply<unknown>>,
) {
  return jsonHandler(schema, (vault, input, context) =>
    call(vault, input, extractSessionToken(context.req.raw), context),
  )
}

function jsonHandler<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  call: (
    vault: VaultStub,
    input: S["Type"],
    context: WorkerContext,
  ) => VaultRpcCall<VaultReply<unknown>>,
) {
  return (context: WorkerContext) =>
    runHttpEffect(
      Effect.gen(function* () {
        const input = yield* decodeJsonEffect(context.req.raw, schema)
        const response = yield* callVaultEffect(context.env, (vault) => call(vault, input, context))
        return vaultReplyResponse(response)
      }),
    )
}
